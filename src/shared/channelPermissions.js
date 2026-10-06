// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const { PermissionFlagsBits: P } = require('discord.js')
const bits = (value) => BigInt(value?.bitfield ?? value ?? 0)

function channelPermissions(channel, guild, member, roles, userId, required = [P.ViewChannel, P.SendMessages]) {
    const roleIds = new Set(member.roles)
    let permissions = bits(roles.find((role) => role.id === guild.id)?.permissions)
    for (const role of roles) if (roleIds.has(role.id)) permissions |= bits(role.permissions)
    if (guild.owner_id === userId || permissions & P.Administrator) return true
    const entries = channel.permission_overwrites || []
    const apply = (deny, allow) => {
        permissions = (permissions & ~bits(deny)) | bits(allow)
    }
    const everyone = entries.find((entry) => entry.id === guild.id)
    if (everyone) apply(everyone.deny, everyone.allow)
    let deny = 0n,
        allow = 0n
    for (const entry of entries) {
        if (entry.type === 0 && entry.id !== guild.id && roleIds.has(entry.id)) {
            deny |= bits(entry.deny)
            allow |= bits(entry.allow)
        }
    }
    apply(deny, allow)
    const user = entries.find((entry) => entry.type === 1 && entry.id === userId)
    if (user) apply(user.deny, user.allow)
    return required.every((permission) => Boolean(permissions & permission))
}

async function assertPrivateAlertChannel({ channel, guild, roles, botId, adminRoleId, fetchMember }) {
    if (channel.type !== 0 || channel.guild_id !== guild.id)
        throw new Error('Administrator alerts require a private server text channel')
    const canView = (roleIds, userId) =>
        channelPermissions(channel, guild, { roles: roleIds }, roles, userId, [P.ViewChannel])
    if (canView([], 'ordinary-member')) throw new Error('Administrator alert channel is visible to @everyone')
    for (const role of roles) {
        if (
            role.id === guild.id ||
            role.id === adminRoleId ||
            bits(role.permissions) & P.Administrator ||
            (role.tags?.bot_id || role.tags?.botId) === botId
        )
            continue
        if (canView([role.id], 'ordinary-member'))
            throw new Error('Administrator alert channel is visible to a non-admin role')
    }
    for (const entry of channel.permission_overwrites || []) {
        if (entry.type !== 1 || entry.id === botId) continue
        const member = await fetchMember(entry.id)
        if (!member) {
            if (canView([], entry.id))
                throw new Error('Administrator alert channel grants access to an unknown account')
            continue
        }
        const roleIds = member.roles
        const admin =
            roleIds.includes(adminRoleId) ||
            guild.owner_id === entry.id ||
            roles.some((role) => roleIds.includes(role.id) && bits(role.permissions) & P.Administrator)
        if (!admin && canView(roleIds, entry.id))
            throw new Error('Administrator alert channel is visible to a non-admin account')
    }
}
module.exports = { channelPermissions, assertPrivateAlertChannel }
