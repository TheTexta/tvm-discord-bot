// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { ApplicationFlagsBitField, PermissionFlagsBits } = require('discord.js')

const required = name => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Missing ${name}`)
    return value
}

const token = required('DISCORD_BOT_TOKEN')
const applicationId = required('DISCORD_APPLICATION_ID')
const guildId = required('TVM_GUILD_ID')
const memberRoleId = required('TVM_MEMBER_ROLE_ID')
const execRoleId = required('TVM_EXEC_ROLE_ID')
const adminRoleId = required('TVM_ADMIN_ROLE_ID')
const alertChannelId = required('TVM_ADMIN_ALERT_CHANNEL_ID')
const base = 'https://discord.com/api/v10'

async function get(path) {
    const response = await fetch(base + path, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(12000)
    })
    return { status: response.status, data: response.ok ? await response.json() : null }
}

function channelPermissions(channel, guild, member, roles, userId) {
    const roleIds = new Set(member.roles)
    let permissions = BigInt(roles.find(role => role.id === guild.id)?.permissions || 0)
    for (const role of roles) if (roleIds.has(role.id)) permissions |= BigInt(role.permissions)
    if (permissions & PermissionFlagsBits.Administrator) return true

    const overwrites = channel.permission_overwrites || []
    const apply = (deny, allow) => { permissions = (permissions & ~deny) | allow }
    const everyone = overwrites.find(overwrite => overwrite.id === guild.id)
    if (everyone) apply(BigInt(everyone.deny), BigInt(everyone.allow))
    let roleDeny = 0n
    let roleAllow = 0n
    for (const overwrite of overwrites) {
        if (overwrite.type === 0 && roleIds.has(overwrite.id)) {
            roleDeny |= BigInt(overwrite.deny)
            roleAllow |= BigInt(overwrite.allow)
        }
    }
    apply(roleDeny, roleAllow)
    const user = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === userId)
    if (user) apply(BigInt(user.deny), BigInt(user.allow))
    return Boolean(permissions & PermissionFlagsBits.ViewChannel) &&
        Boolean(permissions & PermissionFlagsBits.SendMessages)
}

async function main() {
    const [application, bot, guild, roles, channel] = await Promise.all([
        get('/oauth2/applications/@me'),
        get('/users/@me'),
        get(`/guilds/${guildId}`),
        get(`/guilds/${guildId}/roles`),
        get(`/channels/${alertChannelId}`)
    ])
    const checks = []
    const check = (label, ok) => {
        checks.push(ok)
        console.log(`${ok ? 'OK' : 'FAIL'} ${label}`)
    }
    check('Bot token and application ID', application.data?.id === applicationId && Boolean(bot.data))
    const flags = BigInt(application.data?.flags || 0)
    const intents = ['GatewayGuildMembers', 'GatewayGuildMembersLimited']
    check('Server Members Intent', intents.some(name => Boolean(flags & BigInt(ApplicationFlagsBitField.Flags[name]))))
    check('Bot can access the configured server', guild.data?.id === guildId)

    let member
    if (bot.data && guild.data) member = await get(`/guilds/${guildId}/members/${bot.data.id}`)
    check('Bot is installed in the server', Boolean(member?.data))
    const targets = [memberRoleId, execRoleId, adminRoleId].map(id => roles.data?.find(role => role.id === id))
    check('Configured membership, executive, and admin roles exist', targets.every(Boolean))
    const botRoles = roles.data?.filter(role => member?.data?.roles.includes(role.id)) || []
    const highest = Math.max(0, ...botRoles.map(role => role.position))
    let basePermissions = BigInt(roles.data?.find(role => role.id === guildId)?.permissions || 0)
    for (const role of botRoles) basePermissions |= BigInt(role.permissions)
    check('Bot has Manage Roles and sits above all assigned roles',
        targets.every(role => role && highest > role.position) && Boolean(basePermissions & PermissionFlagsBits.ManageRoles))
    check('Bot can access the configured alert channel', channel.data?.guild_id === guildId)
    if (channel.data && guild.data && member?.data && roles.data) {
        check('Bot can view and send in the alert channel',
            channelPermissions(channel.data, guild.data, member.data, roles.data, bot.data.id))
    }
    if (checks.includes(false)) process.exitCode = 1
}

main().catch(error => {
    console.error(`Discord setup check failed: ${error.name || 'request error'}`)
    process.exitCode = 1
})
