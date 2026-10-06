// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Collection, PermissionFlagsBits } = require('discord.js')
const UnverifiedRoleManager = require('../src/tvm/UnverifiedRoleManager')
const { uiText } = require('../src/tvm/uiText')

function fixture() {
    const manager = new UnverifiedRoleManager('guild', 'unverified', ['member', 'exec', 'admin'])
    const changes = []
    const guild = { id: 'guild', members: {} }
    const member = (ids, bot = false) => ({
        id: 'user',
        guild,
        user: { bot },
        roles: {
            cache: new Collection(ids.map((id) => [id, { id }])),
            add: async (id) => changes.push(['add', id]),
            remove: async (id) => changes.push(['remove', id])
        }
    })
    return { manager, changes, guild, member }
}

test('assigns only roleless humans in the target guild', async () => {
    const { manager, changes, guild, member } = fixture()
    guild.members.fetch = async () => member(['guild'])
    assert.equal(await manager.syncMember(member(['guild'])), 'added')
    for (const ids of [
        ['guild', 'member'],
        ['guild', 'custom'],
        ['guild', 'booster'],
        ['guild', 'unverified']
    ]) {
        assert.equal(await manager.syncMember(member(ids)), null)
    }
    assert.equal(await manager.syncMember(member(['guild'], true)), null)
    assert.equal(await manager.syncMember({ ...member(['guild']), guild: { id: 'other' } }), null)
    assert.deepEqual(changes, [['add', 'unverified']])
})

test('removes Unverified after verification or any other role grant', async () => {
    const { manager, changes, guild, member } = fixture()
    for (const other of ['member', 'exec', 'admin', 'custom']) {
        guild.members.fetch = async () => member(['guild', 'unverified', other])
        assert.equal(await manager.syncMember(member(['guild', 'unverified', other])), 'removed')
    }
    assert.deepEqual(
        changes,
        Array.from({ length: 4 }, () => ['remove', 'unverified'])
    )
})

test('rechecks stale events before assigning or removing the role', async () => {
    const { manager, changes, guild, member } = fixture()
    guild.members.fetch = async (options) => {
        assert.equal(options.force, true)
        return member(['guild', 'member'])
    }
    assert.equal(await manager.syncMember(member(['guild'])), null)
    guild.members.fetch = async () => member(['guild', 'unverified'])
    assert.equal(await manager.syncMember(member(['guild', 'unverified', 'member'])), null)
    guild.members.fetch = async () => {
        throw Object.assign(new Error('Member left'), { code: 10007 })
    }
    assert.equal(await manager.syncMember(member(['guild'])), null)
    assert.deepEqual(changes, [])
})

test('bulk reconciliation continues after one assignment fails', async () => {
    const { manager, changes, guild, member } = fixture()
    const failed = member(['guild'])
    const eligible = { ...member(['guild']), id: 'second' }
    guild.members.fetch = async (options) => {
        if (!options)
            return new Collection([
                ['user', failed],
                ['second', eligible]
            ])
        if (options.user === 'user') throw new Error('Cannot manage role')
        return eligible
    }
    const result = await manager.syncGuild(guild)
    assert.deepEqual(result, { added: 1, removed: 0, failed: 1 })
    assert.deepEqual(changes, [['add', 'unverified']])
})

function roleFixture(roleId = null, existing = []) {
    const manager = new UnverifiedRoleManager('guild', roleId, ['member', 'exec', 'admin'])
    const created = []
    const makeRole = (id, overrides = {}) => ({
        id,
        name: uiText('roles.unverified'),
        permissions: { bitfield: 0n },
        managed: false,
        mentionable: true,
        ...overrides
    })
    const guild = {
        id: 'guild',
        members: {
            fetchMe: async () => ({
                permissions: { has: (flag) => flag === PermissionFlagsBits.ManageRoles },
                roles: { highest: { comparePositionTo: () => 1 } }
            })
        },
        roles: {
            fetch: async () => new Collection(existing.map((role) => [role.id, role])),
            create: async (options) => {
                created.push(options)
                return makeRole('created')
            }
        }
    }
    return { manager, guild, created, makeRole }
}

test('creates a mentionable role with no permissions and reuses it on restart', async () => {
    const { manager, guild, created } = roleFixture()
    const role = await manager.initialize(guild)
    assert.equal(manager.roleId, 'created')
    assert.deepEqual(created[0].permissions, [])
    assert.equal(created[0].mentionable, true)
    const next = roleFixture(null, [role])
    assert.equal(await next.manager.initialize(next.guild), role)
    assert.deepEqual(next.created, [])
})

test('rejects missing, ambiguous, managed, privileged, or conflicting roles', async () => {
    const { makeRole } = roleFixture()
    for (const [roleId, roles] of [
        ['missing', []],
        [null, [makeRole('one'), makeRole('two')]],
        ['member', [makeRole('member')]],
        ['guild', [makeRole('guild')]],
        ['managed', [makeRole('managed', { managed: true })]],
        ['privileged', [makeRole('privileged', { permissions: { bitfield: 8n } })]]
    ]) {
        const { manager, guild } = roleFixture(roleId, roles)
        await assert.rejects(manager.initialize(guild))
    }
    const hierarchy = roleFixture('low', [makeRole('low')])
    hierarchy.guild.members.fetchMe = async () => ({
        permissions: { has: () => true },
        roles: { highest: { comparePositionTo: () => -1 } }
    })
    await assert.rejects(hierarchy.manager.initialize(hierarchy.guild), { message: uiText('errors.unsafeUnverified') })
})

test('enables mentions on an existing eligible role', async () => {
    const { makeRole } = roleFixture()
    let mentionable
    const role = makeRole('existing', {
        mentionable: false,
        setMentionable: async (value) => {
            mentionable = value
        }
    })
    const { manager, guild, created } = roleFixture('existing', [role])
    await manager.initialize(guild)
    assert.equal(mentionable, true)
    assert.deepEqual(created, [])
})
