// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PermissionFlagsBits: P } = require('discord.js')
const { assertPrivateAlertChannel, channelPermissions } = require('../src/shared/channelPermissions')

function fixture() {
    return {
        channel: {
            type: 0,
            guild_id: 'guild',
            permission_overwrites: [
                { id: 'guild', type: 0, allow: 0n, deny: P.ViewChannel },
                { id: 'admin', type: 0, allow: P.ViewChannel, deny: 0n }
            ]
        },
        guild: { id: 'guild' },
        roles: [
            { id: 'guild', permissions: P.ViewChannel },
            { id: 'member', permissions: P.ViewChannel },
            { id: 'admin', permissions: 0n }
        ],
        botId: 'bot',
        adminRoleId: 'admin',
        fetchMember: async () => ({ roles: ['member'] })
    }
}
test('alert privacy permits configured admins and rejects public and role-based access', async () => {
    const f = fixture()
    await assertPrivateAlertChannel(f)
    assert.equal(
        channelPermissions(f.channel, f.guild, { roles: ['admin'] }, f.roles, 'admin-user', [P.ViewChannel]),
        true
    )
    f.channel.permission_overwrites.push({ id: 'member', type: 0, allow: P.ViewChannel, deny: 0n })
    await assert.rejects(assertPrivateAlertChannel(f), /non-admin role/)
    f.channel.permission_overwrites = []
    await assert.rejects(assertPrivateAlertChannel(f), /everyone/)
})
test('alert privacy checks direct member overwrites and owner/administrator exceptions', async () => {
    const f = fixture()
    f.channel.permission_overwrites.push({ id: 'user', type: 1, allow: P.ViewChannel, deny: 0n })
    await assert.rejects(assertPrivateAlertChannel(f), /non-admin account/)
    f.fetchMember = async () => ({ roles: ['admin'] })
    await assertPrivateAlertChannel(f)
    f.fetchMember = async () => null
    await assert.rejects(assertPrivateAlertChannel(f), /unknown account/)
    f.guild.owner_id = 'user'
    f.fetchMember = async () => ({ roles: [] })
    await assertPrivateAlertChannel(f)
})
