// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { joinDeadline, BOT_PERMISSIONS } = require('../src/shoots/ShootService')
const { ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const { IDS, fields, fixture, allows } = require('./helpers/shoot')

test('setup creates one private chat, pinned brief, invitation, and immutable invitations', async (t) => {
    const f = await fixture(t)
    const { shoot, submit } = await f.create()
    assert.equal(shoot.status, 'open')
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.parentId, IDS.active)
    assert.equal(allows(chat, IDS.invited, P.SendMessages), true)
    assert.equal(allows(chat, IDS.admin, P.ViewChannel), true)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    assert.ok(chat.permissionOverwrites.cache.get(IDS.guild).deny.has(P.ViewChannel))
    assert.ok(chat.permissionOverwrites.cache.get(IDS.invited).deny.has(P.CreatePublicThreads))
    assert.equal(chat.messages.cache.get(shoot.brief_id).pinned, true)
    assert.deepEqual(f.channels.get(IDS.announce).sends[0].allowedMentions, { parse: [] })
    assert.ok(submit.replies.at(-1).content.includes(shoot.channel_id))
    const invitation = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    assert.ok(invitation.reactions.cache.get('🎬').me)
    await f.store.setShootReaction(shoot.id, IDS.invited, true, shoot.announcement_id)
    await f.store.setShootReaction(shoot.id, IDS.invited, false, shoot.announcement_id)
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.invited).invited, 1)
})

test('command and modal permissions are checked independently; invalid invites cannot provision', async (t) => {
    const f = await fixture(t)
    const denied = f.interaction({ command: 'setup', userId: IDS.invited })
    await f.service.handleInteraction(denied)
    assert.equal(denied.modal, undefined)
    const setup = f.interaction({ command: 'setup', mentions: `<@${IDS.outsider}>` })
    await f.service.handleInteraction(setup)
    const lostPermission = f.interaction({ customId: setup.modal.custom_id, userId: IDS.invited })
    await f.service.handleInteraction(lostPermission)
    const submit = f.interaction({ customId: setup.modal.custom_id })
    await f.service.handleInteraction(submit)
    const shoot = await f.store.getShoot(setup.modal.custom_id.split(':')[3], IDS.guild)
    assert.equal(shoot.status, 'draft')
    assert.equal(shoot.channel_id, null)
    assert.ok(submit.replies.at(-1).content.includes('verified'))
})

test('close creates a read-only archive, blocks new joins, allows withdrawal, and reopens', async (t) => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    await f.react(shoot, 'joined')
    const close = f.interaction({ command: 'close', channelId: shoot.channel_id })
    await f.service.handleInteraction(close)
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(shoot.status, 'closed')
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.parentId, IDS.archive)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    for (const flag of [P.SendMessages, P.SendMessagesInThreads, P.AddReactions, P.CreatePrivateThreads]) {
        assert.ok(chat.permissionOverwrites.cache.get(IDS.joined).deny.has(flag))
    }
    await f.react(shoot, 'extra')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.invited, P.ViewChannel))
    const reopen = f.interaction({ command: 'reopen', channelId: shoot.channel_id })
    await f.service.handleInteraction(reopen)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'open')
    assert.equal(chat.parentId, IDS.active)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    await f.react(shoot, 'extra')
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
})

test('reconciliation removes access after verification is revoked; organizer access persists', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.store.releaseClaim(IDS.guild, 'joined@example.org', IDS.admin)
    await f.store.releaseClaim(IDS.guild, 'invited@example.org', IDS.admin)
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.invited), false)
    assert.ok(allows(chat, IDS.admin, P.ViewChannel))
})

test('initialization validates category type and bot permissions', async (t) => {
    const f = await fixture(t)
    f.channels.get(IDS.active).permissions = new PermissionsBitField(0n)
    await assert.rejects(f.service.initialize(), /permissions/)
    f.channels.get(IDS.active).permissions = new PermissionsBitField(BOT_PERMISSIONS)
    f.channels.get(IDS.archive).type = ChannelType.GuildText
    await assert.rejects(f.service.initialize(), /configuration/)
})

test('unchanged REST embeds are not repeatedly edited during reconciliation', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.reconcileAll()
    await f.service.reconcileAll()
    assert.equal(f.channels.get(shoot.channel_id).messages.cache.get(shoot.brief_id).edits.length, 1)
    assert.equal(f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).edits.length, 1)
})

test('grant failure is retried durably; a failed leave is retried to revoke access', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const chat = f.channels.get(shoot.channel_id)
    chat.failEdit = true
    await f.react(shoot, 'joined')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.joined).reacted, 1)
    await f.restart()
    await f.service.reconcileAll()
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    chat.failEdit = true
    await f.react(shoot, 'joined', false)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    await f.service.reconcileAll()
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('bots and unrelated announcement messages cannot enroll participants', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'bot')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.bot), true)
    assert.equal(
        (await f.store.shootParticipants(shoot.id)).some((row) => row.user_id === IDS.bot),
        false
    )
    await f.service.onReaction(
        {
            emoji: { id: null, name: '🎬' },
            message: { id: '999999999999999999', guildId: IDS.guild, channelId: IDS.announce }
        },
        f.members.get(IDS.joined).user
    )
    assert.equal(
        (await f.store.shootParticipants(shoot.id)).some((row) => row.user_id === IDS.joined),
        false
    )
})

test('setup modal separates optional date/time and defaults its joining dropdown to one day', async (t) => {
    const f = await fixture(t)
    const { setup, shoot } = await f.create()
    assert.equal(setup.modal.components.length, 5)
    const components = setup.modal.components.map((label) => label.component)
    assert.deepEqual(
        components.slice(0, 4).map((component) => component.custom_id),
        ['name', 'date', 'time', 'location']
    )
    assert.equal(components[1].required, false)
    assert.equal(components[2].required, false)
    const select = components[4]
    assert.equal(select.type, 3)
    assert.equal(select.custom_id, 'join_period')
    assert.deepEqual(
        select.options.map((option) => option.value),
        ['day', 'two_days', 'week', 'month', 'never']
    )
    assert.deepEqual(
        select.options.filter((option) => option.default).map((option) => option.value),
        ['day']
    )
    assert.equal(joinDeadline(shoot), shoot.join_started_at + 86400000)
    assert.equal(
        shoot.join_started_at,
        f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).createdTimestamp
    )
})

test('expiry keeps the chat and members open, rejects new joins, and permits admin additions', async (t) => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.store.updateShoot(shoot.id, { join_started_at: Date.now() - 86400001 })
    await f.restart()
    await f.service.reconcileAll()
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(shoot.status, 'open')
    assert.equal(chat.parentId, IDS.active)
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    const reaction = await f.react(shoot, 'extra')
    assert.equal(reaction.normal.has(IDS.extra), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    assert.match(f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).content, /expired/)
    await f.service.handleInteraction(
        f.interaction({ command: 'add', channelId: shoot.channel_id, userId: IDS.invited })
    )
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    await f.service.handleInteraction(
        f.interaction({ command: 'add', channelId: shoot.channel_id, addUserId: IDS.outsider })
    )
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    await f.react(shoot, 'extra')
    await f.react(shoot, 'extra', false)
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    await f.react(shoot, 'joined')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('Admin Team can use every shoot control without Administrator or a roster claim', async (t) => {
    const f = await fixture(t)
    const organizer = f.members.get(IDS.outsider)
    organizer.roles.cache.set(IDS.adminRole, { id: IDS.adminRole, name: 'Admin Team' })
    assert.equal(organizer.permissions.has(P.Administrator), false)
    assert.equal(await f.store.isAuthorizedUser(IDS.guild, organizer.id), false)
    const setup = f.interaction({ command: 'setup', userId: organizer.id })
    await f.service.handleInteraction(setup)
    assert.ok(setup.modal)
    const submit = f.interaction({ customId: setup.modal.custom_id, userId: organizer.id })
    await f.service.handleInteraction(submit)
    let shoot = await f.store.getShoot(setup.modal.custom_id.split(':')[3], IDS.guild)
    assert.equal(shoot.status, 'open')
    assert.equal(shoot.organizer_id, organizer.id)
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, organizer.id, P.SendMessages))
    assert.ok(allows(chat, IDS.adminRole, P.ViewChannel))
    assert.ok(allows(chat, IDS.adminRole, P.UseApplicationCommands))
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id, userId: organizer.id })
    await f.service.handleInteraction(edit)
    const editSubmit = f.interaction({
        customId: edit.modal.custom_id,
        channelId: shoot.channel_id,
        userId: organizer.id
    })
    editSubmit.fields = fields('Updated shoot')
    await f.service.handleInteraction(editSubmit)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).name, 'Updated shoot')
    for (const command of ['crew', 'add', 'close']) {
        const control = f.interaction({ command, channelId: shoot.channel_id, userId: organizer.id })
        await f.service.handleInteraction(control)
        assert.equal(control.deferred, true)
    }
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(shoot.status, 'closed')
    assert.ok(allows(chat, organizer.id, P.SendMessages))
    assert.ok(allows(chat, IDS.adminRole, P.SendMessages))
    assert.equal(allows(chat, IDS.extra, P.SendMessages), false)
    const reopen = f.interaction({ command: 'reopen', channelId: shoot.channel_id, userId: organizer.id })
    await f.service.handleInteraction(reopen)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'open')
    assert.equal(f.errors.length, 0)
})

test('Admin Team can manage another organizer’s archived shoot and lose authority when the role is removed', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const admin = f.members.get(IDS.outsider)
    admin.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    await f.react(shoot, 'outsider')
    await f.service.handleInteraction(
        f.interaction({ command: 'close', channelId: shoot.channel_id, userId: admin.id })
    )
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, admin.id, P.SendMessages))
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id, userId: admin.id })
    await f.service.handleInteraction(edit)
    assert.ok(edit.modal)
    admin.roles.cache.delete(IDS.adminRole)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id, userId: admin.id })
    await f.service.handleInteraction(submit)
    assert.match(submit.replies.at(-1).content, /Admin Team role/)
    await f.service.reconcileAll()
    assert.equal(chat.permissionOverwrites.cache.has(admin.id), false)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'closed')
})

test('removing Admin Team from a verified archived participant restores read-only access', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const participant = f.members.get(IDS.invited)
    participant.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, participant.id, P.SendMessages))
    participant.roles.cache.delete(IDS.adminRole)
    await f.service.reconcileAll()
    assert.ok(allows(chat, participant.id, P.ViewChannel))
    assert.equal(allows(chat, participant.id, P.SendMessages), false)
    assert.ok(chat.permissionOverwrites.cache.get(participant.id).deny.has(P.SendMessages))
})

test('direct invitations are names only in the private brief and never appear in announcements', async (t) => {
    const f = await fixture(t)
    f.members.get(IDS.invited).displayName = 'Owen (Executive Producer)'
    const { shoot } = await f.create()
    const announcement = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const brief = f.channels.get(shoot.channel_id).messages.cache.get(shoot.brief_id)
    assert.equal(announcement.content, 'React 🎬 to join; remove your reaction to leave.')
    assert.doesNotMatch(JSON.stringify(announcement.embeds), /Owen|Direct invitations/)
    assert.doesNotMatch(announcement.content, /<@|Verified TVM/)
    const invited = brief.embeds[0].toJSON().fields.filter((field) => field.name === 'Direct invitations')
    assert.equal(invited.length, 1)
    assert.match(invited[0].value, /Owen/)
    assert.doesNotMatch(invited[0].value, /<@/)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    const updated = brief.embeds[0].toJSON().fields.filter((field) => field.name === 'Direct invitations')
    assert.match(updated.map((field) => field.value).join(' '), /extra/)
    for (const channel of [f.channels.get(IDS.announce), f.channels.get(shoot.channel_id)]) {
        for (const payload of [
            ...channel.sends,
            ...[...channel.messages.cache.values()].flatMap((message) => message.edits)
        ]) {
            assert.deepEqual(payload.allowedMentions, { parse: [] })
        }
    }
})

test('closed announcement is removed at the 24-hour boundary without losing archive access', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const channel = f.channels.get(IDS.announce)
    const closed = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(closed.closed_at)
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 86400000 + 60000 })
    await f.service.reconcileAll()
    assert.equal(channel.messages.cache.has(shoot.announcement_id), true)
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 86400000 })
    await f.restart()
    await f.service.reconcileAll()
    const removed = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(removed.announcement_deleted_at)
    assert.equal(channel.messages.cache.has(shoot.announcement_id), false)
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    assert.equal(allows(chat, IDS.joined, P.SendMessages), false)
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).closed_at, null)
    assert.equal(channel.sends.length, 2)
    assert.equal(channel.messages.cache.size, 1)
    assert.equal(f.errors.length, 0)
})
