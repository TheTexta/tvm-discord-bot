// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { MessageFlags } = require('discord.js')
const { uiText } = require('./uiText')
const { parseRoster } = require('./roster')
const { normalizeEmail, validEmail, validSnowflake } = require('./validation')
const { roleKinds, managedColumns } = require('./roles')

function createRosterCommands({
    config,
    store,
    withMembershipLock,
    membership,
    privateReply,
    unverifiedRoles,
    alertAdmins
}) {
    const { roleIds, existingRoles, roleSummary, addMissingRoles, removeManagedRoles, reconcile } = membership
    async function uploadRoster(interaction) {
        const attachment = interaction.options.getAttachment('csv')
        if (!attachment || attachment.size > 2 * 1024 * 1024) throw new Error(uiText('errors.csvSize'))
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(uiText('errors.csvDownload'))
        const rows = parseRoster(await response.text())
        const outcome = await withMembershipLock(async () => {
            const imported = await store.mergeRoster(config.guildId, rows, interaction.user.id)
            const reconciliation = await reconcile(interaction.guild)
            return { ...imported, ...reconciliation }
        })
        await privateReply(interaction, uiText('admin.uploadComplete', outcome))
    }

    async function handleRoster(interaction) {
        const subcommand = interaction.options.getSubcommand()
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        if (subcommand === 'status') {
            const status = await store.status(config.guildId)
            await privateReply(
                interaction,
                status.meta
                    ? uiText('admin.status', {
                          count: status.count,
                          version: status.meta.version,
                          unreconciled: status.unreconciled
                      })
                    : uiText('admin.noRoster')
            )
            return
        }
        if (subcommand === 'audit') {
            const entries = await store.audit(config.guildId)
            await privateReply(
                interaction,
                entries.length
                    ? entries
                          .map((entry) =>
                              uiText('admin.auditEntry', {
                                  timestamp: new Date(entry.at).toISOString(),
                                  action: uiText(`auditActions.${entry.action}`),
                                  actor: validSnowflake(entry.actor_id) ? `<@${entry.actor_id}>` : entry.actor_id,
                                  detail: entry.detail
                              })
                          )
                          .join('\n')
                          .slice(0, 1900)
                    : uiText('admin.noAudit')
            )
            return
        }
        if (subcommand === 'reconcile') {
            const result = await withMembershipLock(() => reconcile(interaction.guild))
            await privateReply(
                interaction,
                uiText('admin.reconciled', {
                    revoked: result.revoked,
                    failed: result.failed,
                    added: result.unverified.added,
                    removed: result.unverified.removed,
                    unverifiedFailed: result.unverified.failed
                })
            )
            return
        }
        if (subcommand === 'repair') {
            const email = normalizeEmail(interaction.options.getString('email'))
            if (!validEmail(email)) throw new Error(uiText('errors.invalidEmail'))
            await withMembershipLock(async () => {
                const roster = await store.lookup(config.guildId, email)
                const claim = await store.claimFor(config.guildId, email)
                if (!roster || !claim) throw new Error(uiText('errors.noActiveClaim'))
                const member = await interaction.guild.members.fetch({ user: claim.user_id, force: true })
                await addMissingRoles(member, email, roster.role)
                await privateReply(
                    interaction,
                    uiText('admin.repaired', { roles: roleSummary(roster.role), userId: claim.user_id })
                )
            })
            return
        }
        if (subcommand === 'release') {
            const email = normalizeEmail(interaction.options.getString('email'))
            if (!validEmail(email)) throw new Error(uiText('errors.invalidEmail'))
            await withMembershipLock(async () => {
                const claim = await store.claimFor(config.guildId, email)
                if (!claim) throw new Error(uiText('errors.noLinkedAccount'))
                const member = await interaction.guild.members
                    .fetch({ user: claim.user_id, force: true })
                    .catch((error) => {
                        if (error.code === 10007) return null
                        throw error
                    })
                await removeManagedRoles(member, claim)
                await store.releaseClaim(config.guildId, email, interaction.user.id)
                if (member)
                    await unverifiedRoles.syncMember(
                        await interaction.guild.members.fetch({ user: member.id, force: true })
                    )
                await privateReply(interaction, uiText('admin.released', { userId: claim.user_id }))
            })
            return
        }
        if (subcommand === 'transfer') {
            const email = normalizeEmail(interaction.options.getString('email'))
            const target = interaction.options.getUser('user')
            if (!validEmail(email)) throw new Error(uiText('errors.invalidEmail'))
            await withMembershipLock(async () => {
                const prior = await store.claimFor(config.guildId, email)
                if (!prior) throw new Error(uiText('errors.noLinkedAccount'))
                if (prior.user_id === target.id) throw new Error(uiText('errors.sameAccount'))
                const roster = await store.lookup(config.guildId, email)
                if (!roster) throw new Error(uiText('errors.emailAbsent'))
                if (await store.claimForUser(config.guildId, target.id)) throw new Error(uiText('errors.targetClaimed'))
                const targetMember = await interaction.guild.members.fetch({ user: target.id, force: true })
                const oldMember = await interaction.guild.members
                    .fetch({ user: prior.user_id, force: true })
                    .catch((error) => {
                        if (error.code === 10007) return null
                        throw error
                    })
                const oldRoles = oldMember
                    ? roleKinds.filter(
                          (kind) => prior[managedColumns[kind]] && oldMember.roles.cache.has(roleIds[kind])
                      )
                    : []
                async function restoreOldRoles() {
                    let failed = false
                    for (const kind of oldRoles) {
                        await oldMember.roles.add(roleIds[kind]).catch(() => {
                            failed = true
                        })
                    }
                    if (failed) await alertAdmins(uiText('alerts.transferFailed'))
                }
                try {
                    await removeManagedRoles(oldMember, prior)
                } catch (error) {
                    await restoreOldRoles()
                    throw error
                }
                try {
                    await store.transfer(
                        config.guildId,
                        email,
                        target.id,
                        interaction.user.id,
                        existingRoles(targetMember)
                    )
                } catch (error) {
                    await restoreOldRoles()
                    throw error
                }
                try {
                    await addMissingRoles(targetMember, email, roster.role)
                    if (oldMember)
                        await unverifiedRoles.syncMember(
                            await interaction.guild.members.fetch({ user: oldMember.id, force: true })
                        )
                } catch (error) {
                    await alertAdmins(uiText('alerts.transferFailed'))
                    throw new Error(uiText('errors.transferRoleFailed'), { cause: error })
                }
                await privateReply(interaction, uiText('admin.transferred', { userId: target.id }))
            })
        }
    }

    return { uploadRoster, handleRoster }
}

module.exports = { createRosterCommands }
