// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('../shared/uiText')

const { PermissionFlagsBits } = require('discord.js')

class UnverifiedRoleManager {
    constructor(guildId, roleId, membershipRoleIds) {
        this.guildId = guildId
        this.roleId = roleId
        this.membershipRoleIds = membershipRoleIds
    }

    async initialize(guild) {
        const roles = await guild.roles.fetch()
        const botMember = await guild.members.fetchMe()
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            throw new Error(uiText('errors.manageRoles'))
        }
        let role
        if (this.roleId) {
            role = roles.get(this.roleId)
            if (!role) throw new Error(uiText('errors.missingUnverified'))
        } else {
            const matches = roles.filter((role) => role.name === uiText('roles.unverified'))
            if (matches.size > 1) throw new Error(uiText('errors.ambiguousUnverified'))
            role =
                matches.first() ||
                (await guild.roles.create({
                    name: uiText('roles.unverified'),
                    permissions: [],
                    mentionable: true,
                    reason: uiText('roleReasons.create')
                }))
        }
        if (
            role.id === guild.id ||
            this.membershipRoleIds.includes(role.id) ||
            role.managed ||
            role.permissions.bitfield !== 0n ||
            botMember.roles.highest.comparePositionTo(role) <= 0
        ) {
            throw new Error(uiText('errors.unsafeUnverified'))
        }
        if (!role.mentionable) await role.setMentionable(true, uiText('roleReasons.mentionable'))
        this.roleId = role.id
        return role
    }

    needsSync(member) {
        if (!this.roleId || member.guild.id !== this.guildId || member.user.bot) return false
        const hasOtherRole = member.roles.cache.some((role) => role.id !== this.guildId && role.id !== this.roleId)
        return member.roles.cache.has(this.roleId) === hasOtherRole
    }

    async syncMember(member) {
        if (!this.needsSync(member)) return null
        // Events and bulk scans can become stale while waiting for the membership
        // lock. Recheck Discord before acting; change only this single role.
        member = await member.guild.members.fetch({ user: member.id, force: true }).catch((error) => {
            if (error.code === 10007) return null
            throw error
        })
        if (!member || !this.needsSync(member)) return null
        if (member.roles.cache.has(this.roleId)) {
            await member.roles.remove(this.roleId, uiText('roleReasons.remove'))
            return 'removed'
        }
        await member.roles.add(this.roleId, uiText('roleReasons.add'))
        return 'added'
    }

    async syncGuild(guild, withLock = (work) => work()) {
        const result = { added: 0, removed: 0, failed: 0 }
        if (guild.id !== this.guildId) return result
        const members = await guild.members.fetch()
        for (const member of members.values()) {
            try {
                const action = await withLock(() => this.syncMember(member))
                if (action) result[action]++
            } catch (error) {
                console.error('[TVM] Unverified role sync failed:', error?.message || error)
                result.failed++
            }
        }
        return result
    }
}

module.exports = UnverifiedRoleManager
