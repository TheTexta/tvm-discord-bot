// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')
const { uiText } = require('../shared/uiText')
const { canManageBot } = require('../shared/permissions')
const { withAdminOperation } = require('../shared/AdminOperation')
const { parseRoster } = require('./roster')
const { normalizeEmail, validEmail, validSnowflake } = require('../shared/validation')
const { roleKinds, managedColumns } = require('./roles')

function previewButtons(token, destructive) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`tvm:roster:confirm:${token}`)
            .setLabel(uiText('buttons.confirmRoster'))
            .setStyle(destructive ? ButtonStyle.Danger : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`tvm:roster:cancel:${token}`)
            .setLabel(uiText('buttons.cancelRoster'))
            .setStyle(ButtonStyle.Secondary)
    )
}

function createRosterCommands({
    config,
    store,
    withMembershipLock,
    membership,
    privateReply,
    unverifiedRoles,
    alertAdmins,
    scheduleReconciliation = (guild) => membership.reconcile(guild),
    healthStatus = () => ({}),
    now = Date.now
}) {
    const { roleIds, roleSummary, addMissingRoles, removeManagedRoles } = membership
    let uploads = Promise.resolve()
    const previews = new Map()
    function sweepPreviews() {
        for (const [token, preview] of previews) if (preview.expiresAt <= now()) previews.delete(token)
    }
    function uploadRoster(interaction) {
        // Reserve arrival order before waiting for Discord's acknowledgement response.
        const acknowledged = Promise.resolve().then(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }))
        acknowledged.catch(() => {})
        // Queue preparation in arrival order. Only a later explicit confirmation writes.
        const next = uploads
            .catch(() => {})
            .then(async () => {
                await acknowledged
                const attachment = interaction.options.getAttachment('csv')
                if (!attachment || attachment.size > 2 * 1024 * 1024) throw new Error(uiText('errors.csvSize'))
                const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) })
                if (!response.ok) throw new Error(uiText('errors.csvDownload'))
                const rows = parseRoster(await response.text())
                const outcome = await store.previewRoster(config.guildId, rows)
                sweepPreviews()
                // Bound retained roster data; each admin has at most one live preview.
                for (const [token, preview] of previews)
                    if (preview.userId === interaction.user.id) previews.delete(token)
                if (previews.size >= 20) throw new Error(uiText('admin.previewBusy'))
                const token = crypto.randomUUID()
                previews.set(token, {
                    rows,
                    version: outcome.version,
                    userId: interaction.user.id,
                    channelId: interaction.channelId,
                    guildId: config.guildId,
                    expiresAt: now() + 10 * 60000
                })
                try {
                    await privateReply(interaction, uiText('admin.uploadPreview', outcome), [
                        previewButtons(token, outcome.omitted > 0 || outcome.demoted > 0)
                    ])
                } catch (error) {
                    previews.delete(token)
                    throw error
                }
            })
        uploads = next
        return next
    }

    async function handleUploadButton(interaction) {
        if (!interaction.customId?.startsWith('tvm:roster:')) return false
        if (!canManageBot(interaction, config.adminRoleId)) {
            await interaction.reply({ content: uiText('admin.permissionRequired'), flags: MessageFlags.Ephemeral })
            return true
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const [, , action, token] = interaction.customId.split(':')
        await withAdminOperation(async (operation) => {
            await withMembershipLock(async () => {
                sweepPreviews()
                const preview = previews.get(token)
                if (
                    !preview ||
                    preview.userId !== interaction.user.id ||
                    preview.channelId !== interaction.channelId ||
                    preview.guildId !== interaction.guildId ||
                    !['confirm', 'cancel'].includes(action)
                )
                    throw new Error(uiText('admin.previewExpired'))
                if (action === 'cancel') {
                    previews.delete(token)
                    await privateReply(interaction, uiText('admin.previewCancelled'))
                    return
                }
                let outcome
                try {
                    outcome = await store.replaceRoster(config.guildId, preview.rows, interaction.user.id, {
                        expectedVersion: preview.version
                    })
                } catch (error) {
                    if (error.code === 'TVM_ROSTER_STALE') previews.delete(token)
                    throw error
                }
                previews.delete(token)
                operation.saved()
                scheduleReconciliation(interaction.guild).catch(() => {})
                await operation.confirm(uiText('admin.uploadComplete', outcome), (content) =>
                    privateReply(interaction, content)
                )
            })
        })
        return true
    }

    async function handleRoster(interaction) {
        return withAdminOperation((operation) => runRoster(interaction, operation))
    }

    async function runRoster(interaction, operation) {
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
                          unreconciled: status.unreconciled,
                          mode: status.meta.authoritative
                              ? uiText('admin.snapshotActive')
                              : uiText('admin.snapshotPending'),
                          sync: JSON.stringify(membership.status?.() || {}),
                          health: JSON.stringify(healthStatus())
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
            const result = await scheduleReconciliation(interaction.guild)
            operation.completed()
            await operation.confirm(
                uiText('admin.reconciled', {
                    revoked: result.revoked,
                    failed: result.failed,
                    added: result.unverified.added,
                    removed: result.unverified.removed,
                    unverifiedFailed: result.unverified.failed
                }),
                (content) => privateReply(interaction, content)
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
                operation.saved(uiText('admin.repairNextSteps'))
                await addMissingRoles(member, email, roster.role)
                operation.completed()
                await operation.confirm(
                    uiText('admin.repaired', { roles: roleSummary(roster.role), userId: claim.user_id }),
                    (content) => privateReply(interaction, content)
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
                operation.saved()
                scheduleReconciliation(interaction.guild).catch(() => {})
                if (member)
                    await unverifiedRoles.syncMember(
                        await interaction.guild.members.fetch({ user: member.id, force: true })
                    )
                operation.completed()
                await operation.confirm(uiText('admin.released', { userId: claim.user_id }), (content) =>
                    privateReply(interaction, content)
                )
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
                    await store.transfer(config.guildId, email, target.id, interaction.user.id)
                } catch (error) {
                    await restoreOldRoles()
                    throw error
                }
                operation.saved(uiText('admin.repairNextSteps'))
                scheduleReconciliation(interaction.guild).catch(() => {})
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
                operation.completed()
                await operation.confirm(uiText('admin.transferred', { userId: target.id }), (content) =>
                    privateReply(interaction, content)
                )
            })
        }
    }

    return { uploadRoster, handleRoster, handleUploadButton, stop: () => previews.clear() }
}

module.exports = { createRosterCommands, previewButtons }
