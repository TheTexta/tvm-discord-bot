// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('./uiText')
const { roleKinds, managedColumns, desiredKinds, configuredRoleIds } = require('./roles')

function createMembershipService({ config, store, unverifiedRoles, alertAdmins, logger = console }) {
    const roleIds = configuredRoleIds(config)
    const roleNames = { member: uiText('roles.member'), exec: uiText('roles.exec'), admin: uiText('roles.admin') }
    const existingRoles = (member) =>
        Object.fromEntries(roleKinds.map((kind) => [kind, member.roles.cache.has(roleIds[kind])]))
    const roleSummary = (role) =>
        desiredKinds(role)
            .map((kind) => roleNames[kind])
            .join(uiText('roles.separator'))

    async function addMissingRoles(member, email, role) {
        for (const kind of desiredKinds(role)) {
            if (member.roles.cache.has(roleIds[kind])) continue
            await store.markRoleManaged(config.guildId, email, member.id, kind)
            member = await member.roles.add(roleIds[kind])
        }
        await unverifiedRoles.syncMember(member)
    }

    async function removeManagedRoles(member, claim, kinds = roleKinds) {
        if (!member) return 0
        let removed = 0
        for (const kind of kinds) {
            if (!claim[managedColumns[kind]]) continue
            if (member.roles.cache.has(roleIds[kind])) {
                await member.roles.remove(roleIds[kind])
                removed++
            }
        }
        return removed
    }
    async function reconcile(guild) {
        const removed = config.autoRoleRevocation ? await store.removedClaims(config.guildId) : []
        let revoked = 0
        let failed = 0
        for (const claim of removed) {
            try {
                const member = await guild.members.fetch(claim.user_id).catch((error) => {
                    if (error.code === 10007) return null
                    throw error
                })
                revoked += await removeManagedRoles(member, claim)
                await store.releaseRemovedClaim(config.guildId, claim.email, claim.user_id)
            } catch (error) {
                logger.error('[TVM] Role revocation failed:', error?.message || error)
                failed++
            }
        }
        const active = await store.activeClaims(config.guildId)
        for (const claim of active) {
            try {
                const member = await guild.members.fetch(claim.user_id).catch((error) => {
                    if (error.code === 10007) return null
                    throw error
                })
                if (!member) continue
                const unwanted = config.autoRoleRevocation
                    ? roleKinds.filter((kind) => !desiredKinds(claim.role).includes(kind))
                    : []
                revoked += await removeManagedRoles(member, claim, unwanted)
                for (const kind of unwanted) {
                    if (claim[managedColumns[kind]])
                        await store.clearRoleManaged(config.guildId, claim.email, claim.user_id, kind)
                }
                await addMissingRoles(member, claim.email, claim.role)
            } catch (error) {
                logger.error('[TVM] Active claim role sync failed:', error?.message || error)
                failed++
            }
        }
        // Existing server role assignments are outside this bot's ownership.
        const unverified = await unverifiedRoles.syncGuild(guild)
        if (unverified.failed) await alertAdmins(uiText('alerts.unverifiedSync', { failed: unverified.failed }))
        if (failed) await alertAdmins(uiText('alerts.claimSync', { failed }))
        return { revoked, failed, unverified }
    }

    return { roleIds, roleNames, existingRoles, roleSummary, addMissingRoles, removeManagedRoles, reconcile }
}

module.exports = { createMembershipService }
