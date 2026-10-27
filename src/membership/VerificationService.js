// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const { MessageFlags } = require('discord.js')
const { uiText } = require('../shared/uiText')
const { normalizeEmail, validEmail } = require('../shared/validation')
const { codeRow } = require('./verificationUi')

function createVerificationService({
    config,
    store,
    mail,
    withMembershipLock,
    membership,
    privateReply,
    alertAdmins,
    logger
}) {
    const verificationQueues = new Map()
    const { roleSummary, addMissingRoles } = membership
    function withVerificationLock(userId, work) {
        const previous = verificationQueues.get(userId) || Promise.resolve()
        const next = previous.catch(() => {}).then(work)
        verificationQueues.set(userId, next)
        return next.finally(() => {
            if (verificationQueues.get(userId) === next) verificationQueues.delete(userId)
        })
    }
    async function sendVerification(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const email = normalizeEmail(interaction.fields.getTextInputValue('email'))
        if (!validEmail(email)) return privateReply(interaction, uiText('verification.invalidEmail'))
        const response = await withMembershipLock(async () => {
            const status = await store.status(config.guildId)
            if (!status.meta || status.count === 0) return 'verification.unavailable'
            if (!(await store.allowRequest(config.guildId, interaction.user.id, email)))
                return 'verification.rateLimited'
            return 'verification.codeSent'
        })
        // Acknowledge before any eligibility lookup, send reservation, account delivery
        // queue, or SMTP I/O. Neither their latency nor their errors reach the caller.
        await privateReply(interaction, uiText(response), response === 'verification.codeSent' ? [codeRow()] : [])
        if (response !== 'verification.codeSent') return
        try {
            await withVerificationLock(interaction.user.id, async () => {
                const prepared = await withMembershipLock(() => prepareVerification(interaction.user.id, email))
                if (!prepared) return
                await mail.sendMail({
                    fromName: uiText('email.fromName'),
                    to: prepared.email,
                    subject: uiText('email.codeSubject'),
                    text: uiText('email.codeBody', { code: prepared.code })
                })
            })
        } catch {
            // Keep ambiguous deliveries usable. Do not expose SMTP text (which can
            // contain the destination), or edit the already-generic member response.
            logger.error('[TVM] Verification delivery failed; see the private administrator alert channel')
            await alertAdmins(uiText('alerts.emailFailed')).catch(() => {})
        }
    }

    async function prepareVerification(userId, email) {
        const row = await store.lookup(config.guildId, email)
        if (!row || !(await store.reserveSend(config.guildId, userId, email))) return null
        const code = crypto.randomInt(100000, 1000000).toString()
        // Save under the membership lock before SMTP I/O. Uploads, releases and
        // transfers during delivery can invalidate it without a later write reviving it.
        await store.savePending(config.guildId, userId, row.email, code)
        return { email: row.email, code }
    }

    async function checkCode(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const code = interaction.fields.getTextInputValue('code').trim()
        if (!/^\d{6}$/.test(code)) {
            await privateReply(interaction, uiText('verification.invalidCodeFormat'))
            return
        }
        await withMembershipLock(async () => {
            const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true })
            const result = await store.verifyAndClaim(config.guildId, interaction.user.id, code)
            if (!result.ok) {
                const message =
                    result.reason === 'claimed'
                        ? uiText('verification.alreadyClaimed')
                        : uiText('verification.invalidCode')
                await privateReply(interaction, message)
                return
            }
            try {
                await addMissingRoles(member, result.email, result.role)
            } catch (error) {
                // Discord may apply a role and lose the response. Keep the claim so an
                // ambiguous API failure can never leave an untracked member role.
                logger.error('[TVM] Role assignment failed:', error?.message || error)
                await alertAdmins(uiText('alerts.roleFailed'))
                await privateReply(interaction, uiText('verification.roleFailed'))
                return
            }
            await privateReply(interaction, uiText('verification.complete', { roles: roleSummary(result.role) }))
        })
    }

    return { sendVerification, checkCode }
}

module.exports = { createVerificationService }
