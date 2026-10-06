// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { EventEmitter } = require('node:events')
const { Collection, PermissionFlagsBits } = require('discord.js')

const config = {
    guildId: '100000000000000001',
    applicationId: '100000000000000002',
    memberRoleId: '100000000000000010',
    execRoleId: '100000000000000011',
    adminRoleId: '100000000000000012',
    alertChannelId: '100000000000000013',
    token: 'fake-token'
}

function prepareClient(client = new EventEmitter(), overrides = {}) {
    const guild = {
        id: config.guildId,
        roles: {
            fetch: async (id) =>
                id
                    ? { id, position: 1, managed: false }
                    : new Collection([[config.guildId, { id: config.guildId, permissions: 0n }]])
        },
        members: {
            fetchMe: async () => ({
                id: '100000000000000099',
                roles: { highest: { position: 10 } },
                permissions: { has: () => true }
            })
        }
    }
    client.guilds = { fetch: async () => guild }
    client.channels = {
        fetch: async () => ({
            guildId: config.guildId,
            type: 0,
            permissionOverwrites: { cache: new Collection() },
            isTextBased: () => true,
            permissionsFor: () => ({ has: () => true }),
            send: async () => {}
        })
    }
    client.login = async () => {
        client.emit('clientReady')
    }
    client.destroy = () => {}
    Object.assign(client, overrides)
    return { client, guild, config, rest: { put: async () => {} }, permission: PermissionFlagsBits.ManageRoles }
}

module.exports = { prepareClient, config }
