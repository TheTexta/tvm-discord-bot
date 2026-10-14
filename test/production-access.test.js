// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const { channelPermissions } = require('../src/shared/channelPermissions')
const { IDS, fixture } = require('./helpers/shoot')

function can(f, chat, userId, ...permissions) {
    const roleIds = [...f.members.get(userId).roles.cache.keys()]
    return channelPermissions(
        {
            permission_overwrites: [...chat.permissionOverwrites.cache.values()].map((entry) => ({
                ...entry,
                allow: entry.allow.bitfield,
                deny: entry.deny.bitfield
            }))
        },
        { id: IDS.guild },
        { roles: roleIds },
        [
            { id: IDS.guild, permissions: P.UseApplicationCommands },
            { id: IDS.memberRole, permissions: P.ViewChannel | P.SendMessages },
            { id: IDS.adminRole, permissions: P.ViewChannel | P.SendMessages | P.ManageRoles },
            { id: IDS.productionRole, permissions: 0n }
        ],
        userId,
        permissions
    )
}

test('global production access replaces Admin Team visibility through close, reopen, restart and reconciliation', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const chat = f.channels.get(shoot.channel_id)
    const admin = f.members.get(IDS.outsider)
    admin.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    assert.equal(can(f, chat, admin.id, P.ViewChannel), false)
    assert.equal(can(f, chat, IDS.invited, P.ViewChannel, P.SendMessages), true)
    admin.roles.cache.set(IDS.productionRole, { id: IDS.productionRole })
    for (const action of ['close', 'reopen', 'close']) {
        await f.service.handleInteraction(f.interaction({ command: action, channelId: shoot.channel_id }))
        assert.equal(
            can(
                f,
                chat,
                admin.id,
                P.ViewChannel,
                P.ReadMessageHistory,
                P.SendMessages,
                P.AttachFiles,
                P.UseApplicationCommands
            ),
            true
        )
        assert.equal(can(f, chat, admin.id, P.CreatePublicThreads), false)
        assert.equal(can(f, chat, admin.id, P.CreatePrivateThreads), false)
        assert.equal(chat.permissionOverwrites.cache.has(IDS.adminRole), false)
    }
    await f.restart()
    await f.service.initialize()
    await f.service.reconcileAll()
    assert.equal(can(f, chat, admin.id, P.ViewChannel, P.SendMessages), true)
    admin.roles.cache.delete(IDS.productionRole)
    assert.equal(can(f, chat, admin.id, P.ViewChannel), false)
})

test('production-access participants can post in archives and return to read-only when that role is removed', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const chat = f.channels.get(shoot.channel_id)
    const participant = f.members.get(IDS.invited)
    participant.roles.cache.set(IDS.productionRole, { id: IDS.productionRole })
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    assert.equal(can(f, chat, participant.id, P.ViewChannel, P.SendMessages), true)
    assert.equal(chat.permissionOverwrites.cache.get(participant.id).deny.has(P.SendMessages), false)
    participant.roles.cache.delete(IDS.productionRole)
    await f.service.reconcileAll()
    assert.equal(can(f, chat, participant.id, P.ViewChannel), true)
    assert.equal(can(f, chat, participant.id, P.SendMessages), false)
    participant.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    await f.service.reconcileAll()
    assert.equal(can(f, chat, participant.id, P.ViewChannel, P.SendMessages), true)
})

test('production access alone grants neither bot management authority nor shoot membership eligibility', async (t) => {
    const f = await fixture(t)
    const member = f.members.get(IDS.outsider)
    member.roles.cache.set(IDS.productionRole, { id: IDS.productionRole })
    assert.equal(await f.service.eligible(f.guild, member.id), false)
    const setup = f.interaction({ command: 'setup', userId: member.id })
    await f.service.handleInteraction(setup)
    assert.equal(setup.modal, undefined)
    assert.match(setup.replies.at(-1).content, /Admin Team role or Discord Administrator/)
})

test('startup rejects missing, managed, permission-bearing and unmanageable production roles', async (t) => {
    for (const invalid of ['missing', 'managed', 'permissions', 'hierarchy']) {
        await t.test(invalid, async (t) => {
            const f = await fixture(t)
            const role = f.guild.roles.cache.get(IDS.productionRole)
            if (invalid === 'missing') f.guild.roles.cache.delete(role.id)
            if (invalid === 'managed') role.managed = true
            if (invalid === 'permissions') role.permissions = new PermissionsBitField(P.Administrator)
            if (invalid === 'hierarchy') role.position = 10
            await assert.rejects(f.service.initialize(), /TVM_PRODUCTION_ACCESS_ROLE_ID/)
        })
    }
})
