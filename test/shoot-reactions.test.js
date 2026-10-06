// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { joiningAllowed } = require('../src/shoots/ShootService')
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const { IDS, fields, fixture, allows } = require('./helpers/shoot')

test('partial, duplicate, and concurrent reaction events join once and preserve direct invitations', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'joined')
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    await Promise.all([
        f.service.onReaction(reaction, f.members.get(IDS.joined).user),
        f.service.onReaction(reaction, f.members.get(IDS.joined).user)
    ])
    assert.equal((await f.store.shootParticipants(shoot.id)).filter((row) => row.user_id === IDS.joined).length, 1)
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    await f.react(shoot, 'invited')
    await f.react(shoot, 'invited', false)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    await f.react(shoot, 'outsider')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    assert.equal(reaction.normal.has(IDS.outsider), false)
    assert.equal(f.notices.length, 1)
    await f.react(shoot, 'joined', true, { emoji: '👍' })
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('normal and super reactions retain membership until both are removed', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.react(shoot, 'joined', true, { burst: true })
    await f.react(shoot, 'joined', false)
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.joined, P.ViewChannel))
    await f.react(shoot, 'joined', false, { burst: true })
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
})

test('restart persists state and catches offline joins, leaves, and bulk reaction removal', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.react(shoot, 'joined', false, { event: false })
    await f.react(shoot, 'extra', true, { event: false })
    await f.restart()
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    message.reactions.cache.clear()
    await f.service.onReactionClear(message)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    assert.ok(message.reactions.cache.get('🎬').me)
})

test('reaction pagination includes every normal and super reaction page', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const reaction = message.reactions.cache.get('🎬')
    for (let i = 0; i < 230; i++) {
        const id = String(600000000000000000n + BigInt(i))
        reaction.normal.set(id, { id, bot: false })
    }
    reaction.burst.set(IDS.extra, f.members.get(IDS.extra).user)
    const users = await f.service.reactionUsers(message)
    assert.equal(users.size, 231)
    assert.equal(reaction.pages.filter((options) => options.type === 0).length, 3)
    assert.ok(users.has(IDS.extra))
})

test('closed offline join attempts are rejected before reopening', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const reaction = await f.react(shoot, 'extra', true, { event: false })
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    assert.equal(reaction.normal.has(IDS.extra), false)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.extra), false)
})

test('participant capacity rejects excess joins without breaking existing access', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const reaction = message.reactions.cache.get('🎬')
    const rows = Array.from({ length: 96 }, (_, i) => ({ email: `crew${i}@example.org`, role: 'gm' }))
    await f.store.replaceRoster(IDS.guild, [...(await f.store.rosterEntries(IDS.guild)), ...rows], IDS.admin)
    for (let i = 0; i < rows.length; i++) {
        const id = String(700000000000000000n + BigInt(i))
        const user = { id, bot: false, send: async () => {} }
        f.members.set(id, { id, user, permissions: new PermissionsBitField(0n) })
        await f.store.savePending(IDS.guild, id, rows[i].email, '123456')
        assert.equal((await f.store.verifyAndClaim(IDS.guild, id, '123456')).ok, true)
        reaction.normal.set(id, user)
    }
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.size, 101) // 98 participants, bot, @everyone, Admin Team.
    await f.react(shoot, 'joined')
    assert.equal(reaction.normal.has(IDS.joined), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.invited, P.ViewChannel))
    assert.equal(f.errors.length, 0)
})

test('failed reaction cleanup cannot prevent revoking an ineligible member', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'joined')
    await f.store.releaseClaim(IDS.guild, 'joined@example.org', IDS.admin)
    reaction.users.remove = async () => {
        throw new Error('missing Manage Messages')
    }
    await f.service.reconcileAll()
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.joined).reacted, 0)
    assert.ok(f.errors.some((error) => error.error.includes('Manage Messages')))
})

test('routine sync and reaction events honor deleted announcements; edit can republish once', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const announcementChannel = f.channels.get(IDS.announce)
    await f.react(shoot, 'joined')
    announcementChannel.messages.cache.delete(shoot.announcement_id)
    await Promise.all([
        f.service.onReaction(
            {
                message: { id: shoot.announcement_id, guildId: IDS.guild, channelId: IDS.announce },
                emoji: { name: '🎬' }
            },
            f.members.get(IDS.joined).user
        ),
        f.service.reconcileAll()
    ])
    await f.service.reconcileAll()
    let current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(current.announcement_deleted_at)
    assert.equal(joiningAllowed(current), false)
    assert.equal(announcementChannel.sends.length, 1)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    assert.equal(announcementChannel.sends.length, 1)
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('Edited shoot')
    await f.service.handleInteraction(submit)
    current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.announcement_deleted_at, null)
    assert.notEqual(current.announcement_id, shoot.announcement_id)
    assert.equal(current.join_started_at, shoot.join_started_at)
    assert.equal(announcementChannel.messages.cache.size, 1)
    assert.equal(announcementChannel.sends.length, 2)
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.joined, P.ViewChannel))
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.extra, P.SendMessages))
    await f.react(current, 'joined')
    await f.react(current, 'joined', false)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
    await f.service.reconcileAll()
    assert.equal(announcementChannel.sends.length, 2)
    assert.equal(f.errors.length, 0)
})
