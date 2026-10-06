// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { ApplicationFlagsBitField, PermissionFlagsBits } = require('discord.js')
const { loadShootConfig } = require('../src/tvm/config')
const { BOT_PERMISSIONS, ANNOUNCEMENT_PERMISSIONS } = require('../src/tvm/shoot/policy')
const { required: requireValue } = require('../src/tvm/validation')
const { uiText } = require('../src/tvm/uiText')

const required = (name) => requireValue(process.env, name)

const token = required('DISCORD_BOT_TOKEN')
const applicationId = required('DISCORD_APPLICATION_ID')
const guildId = required('TVM_GUILD_ID')
const memberRoleId = required('TVM_MEMBER_ROLE_ID')
const execRoleId = required('TVM_EXEC_ROLE_ID')
const adminRoleId = required('TVM_ADMIN_ROLE_ID')
const unverifiedRoleId = process.env.TVM_UNVERIFIED_ROLE_ID?.trim()
const alertChannelId = required('TVM_ADMIN_ALERT_CHANNEL_ID')
const shoots = loadShootConfig()
const base = 'https://discord.com/api/v10'

async function get(path) {
    const response = await fetch(base + path, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(12000)
    })
    return { status: response.status, data: response.ok ? await response.json() : null }
}

function channelPermissions(
    channel,
    guild,
    member,
    roles,
    userId,
    requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
) {
    const roleIds = new Set(member.roles)
    let permissions = BigInt(roles.find((role) => role.id === guild.id)?.permissions || 0)
    for (const role of roles) if (roleIds.has(role.id)) permissions |= BigInt(role.permissions)
    if (permissions & PermissionFlagsBits.Administrator) return true

    const overwrites = channel.permission_overwrites || []
    const apply = (deny, allow) => {
        permissions = (permissions & ~deny) | allow
    }
    const everyone = overwrites.find((overwrite) => overwrite.id === guild.id)
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
    const user = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === userId)
    if (user) apply(BigInt(user.deny), BigInt(user.allow))
    return requiredPermissions.every((permission) => Boolean(permissions & permission))
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
    check(
        'Server Members Intent',
        intents.some((name) => Boolean(flags & BigInt(ApplicationFlagsBitField.Flags[name])))
    )
    check('Bot can access the configured server', guild.data?.id === guildId)

    let member
    if (bot.data && guild.data) member = await get(`/guilds/${guildId}/members/${bot.data.id}`)
    check('Bot is installed in the server', Boolean(member?.data))
    const targets = [memberRoleId, execRoleId, adminRoleId].map((id) => roles.data?.find((role) => role.id === id))
    check('Configured membership, executive, and admin roles exist', targets.every(Boolean))
    const unverified = unverifiedRoleId
        ? roles.data?.find((role) => role.id === unverifiedRoleId)
        : roles.data?.find((role) => role.name === uiText('roles.unverified'))
    if (unverifiedRoleId || unverified) {
        check(
            'Unverified is a separate role with no permissions and mentions enabled',
            Boolean(unverified) &&
                ![guildId, memberRoleId, execRoleId, adminRoleId].includes(unverified.id) &&
                !unverified.managed &&
                BigInt(unverified.permissions) === 0n &&
                unverified.mentionable
        )
        targets.push(unverified)
    }
    const botRoles = roles.data?.filter((role) => member?.data?.roles.includes(role.id)) || []
    const highest = Math.max(0, ...botRoles.map((role) => role.position))
    let basePermissions = BigInt(roles.data?.find((role) => role.id === guildId)?.permissions || 0)
    for (const role of botRoles) basePermissions |= BigInt(role.permissions)
    check(
        'Bot has Manage Roles and sits above all assigned roles',
        targets.every((role) => role && highest > role.position) &&
            Boolean(basePermissions & PermissionFlagsBits.ManageRoles)
    )
    check('Bot can access the configured alert channel', channel.data?.guild_id === guildId)
    if (channel.data && guild.data && member?.data && roles.data) {
        check(
            'Bot can view and send in the alert channel',
            channelPermissions(channel.data, guild.data, member.data, roles.data, bot.data.id)
        )
    }
    if (shoots) {
        const definitions = [
            [shoots.announcementChannelId, 0, ANNOUNCEMENT_PERMISSIONS, 'Shoot announcement channel'],
            [shoots.categoryId, 4, BOT_PERMISSIONS, 'Active shoot category'],
            [shoots.archiveCategoryId, 4, BOT_PERMISSIONS, 'Archived shoot category']
        ]
        const shootChannels = await Promise.all(definitions.map(([id]) => get(`/channels/${id}`)))
        definitions.forEach(([, type, permissions, label], index) => {
            const data = shootChannels[index].data
            check(
                `${label} exists in this server with the expected type`,
                data?.guild_id === guildId && data?.type === type
            )
            check(
                `${label} grants the bot all required permissions`,
                Boolean(data && guild.data && member?.data && roles.data) &&
                    channelPermissions(data, guild.data, member.data, roles.data, bot.data.id, permissions)
            )
        })
    }
    if (checks.includes(false)) process.exitCode = 1
}

main().catch((error) => {
    console.error(`Discord setup check failed: ${error.name || 'request error'}`)
    process.exitCode = 1
})
