// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PermissionFlagsBits: P } = require('discord.js')
const { IDS, fixture, allows } = require('./helpers/shoot')

test('shoot add accepts GM, Exec, and Admin Team roles without a verification link', async (t) => {
    for (const [name, roleId] of [
        ['GM', IDS.memberRole],
        ['Exec', IDS.execRole],
        ['Admin Team', IDS.adminRole]
    ]) {
        await t.test(name, async (t) => {
            const f = await fixture(t)
            const member = f.members.get(IDS.outsider)
            member.roles.cache.set(roleId, { id: roleId, name })
            assert.equal(await f.store.isAuthorizedUser(IDS.guild, member.id), false)
            assert.equal(member.permissions.has(P.Administrator), false)
            const { shoot } = await f.create()
            await f.store.updateShoot(shoot.id, { join_started_at: Date.now() - 86400001 })
            const add = f.interaction({ command: 'add', channelId: shoot.channel_id, addUserId: member.id })
            await f.service.handleInteraction(add)
            assert.match(add.replies.at(-1).content, /Added/)
            const row = (await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === member.id)
            assert.equal(row.invited, 1)
            assert.ok(allows(f.channels.get(shoot.channel_id), member.id, P.SendMessages))
            await f.restart()
            await f.service.reconcileAll()
            assert.ok(allows(f.channels.get(shoot.channel_id), member.id, P.SendMessages))
            assert.equal(f.errors.length, 0)
        })
    }
})

test('GM members can be invited during setup and join by reaction without verification links', async (t) => {
    const f = await fixture(t)
    for (const name of ['invited', 'joined']) {
        await f.store.releaseClaim(IDS.guild, `${name}@example.org`, IDS.admin)
        assert.equal(await f.store.isAuthorizedUser(IDS.guild, IDS[name]), false)
    }
    const { shoot } = await f.create()
    assert.equal(shoot.status, 'open')
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    await f.react(shoot, 'joined')
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    await f.service.reconcileAll()
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    assert.equal(f.notices.length, 0)
    assert.equal(f.errors.length, 0)
})

test('shoot add rejects members below GM, lookalike roles, and bots with membership roles', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    f.members.get(IDS.extra).roles.cache.clear()
    assert.equal(await f.store.isAuthorizedUser(IDS.guild, IDS.extra), true)
    const fakeRoleId = '100000000000000099'
    f.members.get(IDS.outsider).roles.cache.set(fakeRoleId, { id: fakeRoleId, name: 'GM', position: 99 })
    f.members.get(IDS.bot).roles.cache.set(IDS.memberRole, { id: IDS.memberRole })
    for (const userId of [IDS.extra, IDS.outsider, IDS.bot]) {
        const add = f.interaction({ command: 'add', channelId: shoot.channel_id, addUserId: userId })
        await f.service.handleInteraction(add)
        assert.match(add.replies.at(-1).content, /must.*GM/)
        assert.equal(
            (await f.store.shootParticipants(shoot.id)).some((row) => row.user_id === userId),
            false
        )
    }
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
})
