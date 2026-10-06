// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { PermissionFlagsBits } = require('discord.js')

function hasAdminTeamRole(member, roleId) {
    return Boolean(roleId && (member?.roles?.cache?.has(roleId) ||
        (Array.isArray(member?.roles) && member.roles.includes(roleId))))
}

function isBotAdmin(member, roleId, permissions = member?.permissions) {
    return !member?.user?.bot && Boolean(permissions?.has(PermissionFlagsBits.Administrator) ||
        hasAdminTeamRole(member, roleId))
}

function canManageBot(interaction, roleId) {
    return !interaction.user?.bot && isBotAdmin(interaction.member, roleId, interaction.memberPermissions)
}

module.exports = { hasAdminTeamRole, isBotAdmin, canManageBot }
