// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('../shared/uiText')
const { roleKinds, managedColumns, desiredKinds, configuredRoleIds } = require('./roles')

function createMembershipService({
    config,
    store,
    unverifiedRoles,
    alertAdmins,
    logger = console,
    withMembershipLock = (work) => work()
}) {
    const roleIds = configuredRoleIds(config)
    const roleNames = { member: uiText('roles.member'), exec: uiText('roles.exec'), admin: uiText('roles.admin') }
    const existingRoles = (member) =>
        Object.fromEntries(roleKinds.map((kind) => [kind, member.roles.cache.has(roleIds[kind])]))
    const roleSummary = (role) =>
        desiredKinds(role)
            .map((kind) => roleNames[kind])
            .join(uiText('roles.separator'))
    let running,
        rerun = false,
        stopped = false
    let lastSuccessAt = null
    let progress = {
        running: false,
        version: null,
        processed: 0,
        total: 0,
        added: 0,
        revoked: 0,
        protected: 0,
        failed: 0
    }

    async function addMissingRoles(member, email, role) {
        let added = 0
        for (const kind of desiredKinds(role)) {
            if (member.roles.cache.has(roleIds[kind])) continue
            // Persist ownership intent before I/O: a lost Discord response remains repairable.
            await store.markRoleManaged(config.guildId, email, member.id, kind)
            member = await member.roles.add(roleIds[kind])
            added++
        }
        await unverifiedRoles.syncMember(member)
        return added
    }
    async function removeManagedRoles(member, claim, kinds = roleKinds) {
        if (!member) return 0
        let removed = 0
        for (const kind of kinds) {
            if (!claim[managedColumns[kind]]) continue
            if (member.roles.cache.has(roleIds[kind])) {
                member = await member.roles.remove(roleIds[kind])
                removed++
            }
        }
        return removed
    }
    function syncUser(guild, userId) {
        return withMembershipLock(async () => {
            // Never act on a claim or tier captured by an earlier scan/snapshot.
            const claim = await store.claimForUser(config.guildId, userId)
            const status = await store.status(config.guildId)
            let member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
                if (error.code === 10007) return null
                throw error
            })
            const result = { added: 0, revoked: 0, protected: 0 }
            if (!claim) {
                if (member) await unverifiedRoles.syncMember(member)
                return result
            }
            result.protected = roleKinds.filter(
                (kind) => !claim[managedColumns[kind]] && member?.roles.cache.has(roleIds[kind])
            ).length
            const desired = claim.role ? desiredKinds(claim.role) : []
            if (status.meta?.authoritative) {
                for (const kind of roleKinds.filter((kind) => !desired.includes(kind))) {
                    if (!claim[managedColumns[kind]]) continue
                    if (member?.roles.cache.has(roleIds[kind])) {
                        member = await member.roles.remove(roleIds[kind])
                        result.revoked++
                    }
                    // Retain the inactive identity; clear only a completed role removal.
                    await store.clearRoleManaged(config.guildId, claim.email, userId, kind)
                }
            }
            if (member && claim.role) result.added = await addMissingRoles(member, claim.email, claim.role)
            else if (member) await unverifiedRoles.syncMember(member)
            return result
        })
    }
    async function scan(guild) {
        do {
            rerun = false
            const status = await store.status(config.guildId)
            const claims = [
                ...(await store.activeClaims(config.guildId)),
                ...(await store.removedClaims(config.guildId))
            ]
            progress = {
                running: true,
                version: status.meta?.version || null,
                processed: 0,
                total: claims.length,
                added: 0,
                revoked: 0,
                protected: 0,
                failed: 0
            }
            for (const claim of claims) {
                if (stopped) break
                try {
                    const result = await syncUser(guild, claim.user_id)
                    for (const key of ['added', 'revoked', 'protected']) progress[key] += result[key]
                } catch (error) {
                    logger.error('[TVM] Membership synchronization failed:', error?.message || error)
                    progress.failed++
                }
                progress.processed++
            }
            progress.unverified = stopped
                ? { added: 0, removed: 0, failed: 0 }
                : await unverifiedRoles.syncGuild(guild, withMembershipLock)
            if (progress.failed) await alertAdmins(uiText('alerts.claimSync', { failed: progress.failed }))
            if (progress.unverified.failed)
                await alertAdmins(uiText('alerts.unverifiedSync', { failed: progress.unverified.failed }))
            // A newer snapshot may have arrived after this scan enumerated its accounts.
            if (((await store.status(config.guildId)).meta?.version || null) !== progress.version) rerun = true
            if (!stopped && !progress.failed && !progress.unverified.failed) lastSuccessAt = Date.now()
            logger.log?.('[TVM] Membership reconciliation:', JSON.stringify(progress))
        } while (rerun && !stopped)
        progress.running = false
        return { ...progress }
    }
    function reconcile(guild) {
        if (stopped) return Promise.resolve({ ...progress })
        if (running) {
            rerun = true
            return running
        }
        running = scan(guild).finally(() => {
            progress.running = false
            running = null
        })
        return running
    }
    return {
        roleIds,
        roleNames,
        existingRoles,
        roleSummary,
        addMissingRoles,
        removeManagedRoles,
        syncUser,
        reconcile,
        status: () => ({ ...progress, lastSuccessAt }),
        stop: () => {
            stopped = true
        },
        drain: () => running || Promise.resolve()
    }
}
module.exports = { createMembershipService }
