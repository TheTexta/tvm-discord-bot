// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const { MessageFlags } = require('discord.js')
const { uiText } = require('./uiText')
const { normalizeEmail, validEmail } = require('./validation')
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
    const { existingRoles, roleSummary, addMissingRoles } = membership
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
        return withVerificationLock(interaction.user.id, async () => {
            const prepared = await withMembershipLock(() => prepareVerification(interaction))
            if (!prepared) return
            try {
                await mail.sendMail({
                    fromName: uiText('email.fromName'),
                    to: prepared.email,
                    subject: uiText('email.codeSubject'),
                    text: uiText('email.codeBody', { code: prepared.code })
                })
                await privateReply(interaction, uiText('verification.codeSent'), [codeRow()])
            } catch (error) {
                // An SMTP response can be lost after delivery. Keep the short-lived
                // challenge usable; the rate and attempt limits still apply.
                logger.error('[TVM] Verification email failed:', error?.message || error)
                await alertAdmins(uiText('alerts.emailFailed'))
                await privateReply(interaction, uiText('verification.emailFailed'))
            }
        })
    }

    async function prepareVerification(interaction) {
        const email = normalizeEmail(interaction.fields.getTextInputValue('email'))
        if (!validEmail(email)) {
            await privateReply(interaction, uiText('verification.invalidEmail'))
            return null
        }
        const status = await store.status(config.guildId)
        if (!status.meta || status.count === 0) {
            await privateReply(interaction, uiText('verification.unavailable'))
            return null
        }
        if (!(await store.allowRequest(config.guildId, interaction.user.id, email))) {
            await privateReply(interaction, uiText('verification.rateLimited'))
            return null
        }
        const row = await store.lookup(config.guildId, email)
        if (!row || !(await store.reserveSend(config.guildId, interaction.user.id, email))) {
            await privateReply(interaction, uiText('verification.codeSent'), [codeRow()])
            return null
        }
        const code = crypto.randomInt(100000, 1000000).toString()
        // Save under the membership lock before SMTP I/O. Uploads, releases and
        // transfers during delivery can invalidate it without a later write reviving it.
        await store.savePending(config.guildId, interaction.user.id, row.email, code)
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
            const result = await store.verifyAndClaim(config.guildId, interaction.user.id, code, existingRoles(member))
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
