// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, MessageFlags
} = require('discord.js')
const { loadConfig } = require('./config')
const { parseRoster } = require('./roster')
const Store = require('./Store')
const SelfSmtpProvider = require('../mail/providers/SelfSmtpProvider')

const config = loadConfig()
const store = new Store(config.databasePath, config.codeSecret)
const mail = new SelfSmtpProvider({
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    isSecure: true,
    username: 'resend',
    password: config.resendApiKey,
    fromAddress: config.smtpFrom
})
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] })
const lastAlertAt = new Map()
async function alertAdmins(message) {
    const now = Date.now()
    if (now - (lastAlertAt.get(message) || 0) < 5 * 60000) return
    lastAlertAt.set(message, now)
    try {
        const channel = await client.channels.fetch(config.alertChannelId)
        if (channel?.isTextBased()) await channel.send({ content: `[TVM verification] ${message}` })
    } catch (error) {
        console.error('[TVM] Could not send administrator alert:', error?.message || error)
    }
}
let membershipQueue = Promise.resolve()
function withMembershipLock(work) {
    const next = membershipQueue.then(work)
    membershipQueue = next.catch(() => {})
    return next
}

const commands = [
    new SlashCommandBuilder().setName('verify').setDescription('Verify your TVM membership with your roster email'),
    new SlashCommandBuilder().setName('source').setDescription('View the source code for this verification bot'),
    new SlashCommandBuilder().setName('postverify').setDescription('Post the TVM verification button here')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('testmail').setDescription('Send a test email through Resend')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('email').setDescription('Destination email').setRequired(true)),
    new SlashCommandBuilder().setName('roster').setDescription('Manage the TVM membership roster')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('status').setDescription('Show active roster status'))
        .addSubcommand(s => s.setName('audit').setDescription('Show recent roster and transfer actions'))
        .addSubcommand(s => s.setName('replace').setDescription('Replace the entire active roster from a CSV')
            .addAttachmentOption(o => o.setName('csv').setDescription('CSV with an Email column').setRequired(true)))
        .addSubcommand(s => s.setName('reconcile').setDescription('Remove the role from members no longer in the roster'))
        .addSubcommand(s => s.setName('repair').setDescription('Restore the member role for an active roster claim')
            .addStringOption(o => o.setName('email').setDescription('Roster email').setRequired(true)))
        .addSubcommand(s => s.setName('release').setDescription('Remove a member role and unlink its roster claim')
            .addStringOption(o => o.setName('email').setDescription('Roster email').setRequired(true)))
        .addSubcommand(s => s.setName('transfer').setDescription('Transfer a roster claim to another Discord account')
            .addStringOption(o => o.setName('email').setDescription('Roster email').setRequired(true))
            .addUserOption(o => o.setName('user').setDescription('New Discord account').setRequired(true)))
].map(command => command.toJSON())

const privateReply = (interaction, content, components = []) => interaction.editReply({ content, components })
const codeRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tvm:open-code').setLabel('Enter email code').setStyle(ButtonStyle.Primary)
)

function emailModal() {
    return new ModalBuilder().setCustomId('tvm:email').setTitle('Verify TVM membership')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('email').setLabel('Email on the TVM member roster')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(254)
        ))
}

function codeModal() {
    return new ModalBuilder().setCustomId('tvm:code').setTitle('Enter verification code')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('code').setLabel('Six-digit email code')
                .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(6)
        ))
}

async function sendVerification(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    return withMembershipLock(() => sendVerificationLocked(interaction))
}

async function sendVerificationLocked(interaction) {
    const email = interaction.fields.getTextInputValue('email').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await privateReply(interaction, 'Enter a valid email address.')
        return
    }
    const status = await store.status(config.guildId)
    if (!status.meta || status.count === 0) {
        await privateReply(interaction, 'Verification is temporarily unavailable. Please contact a TVM administrator.')
        return
    }
    if (!await store.allowRequest(config.guildId, interaction.user.id, email)) {
        await privateReply(interaction, 'Please wait before requesting another code.')
        return
    }
    const row = await store.lookup(config.guildId, email)
    const generic = 'If this email is on the TVM roster, a code has been sent. Check your inbox and junk folder, then enter the code below.'
    if (!row) {
        await privateReply(interaction, generic, [codeRow()])
        return
    }
    if (!await store.reserveSend(config.guildId, interaction.user.id, email)) {
        await privateReply(interaction, generic, [codeRow()])
        return
    }
    const code = crypto.randomInt(100000, 1000000).toString()
    try {
        await mail.sendMail({
            fromName: 'TVM Verification', to: row.email, subject: 'Your TVM Discord verification code',
            text: `Your TVM Discord verification code is ${code}. It expires in 15 minutes. If you did not request it, you can ignore this email.`
        })
        await store.savePending(config.guildId, interaction.user.id, row.email, code)
        await privateReply(interaction, generic, [codeRow()])
    } catch (error) {
        console.error('[TVM] Verification email failed:', error?.message || error)
        await alertAdmins('Verification email delivery failed. Check Resend and the bot logs.')
        await privateReply(interaction, 'Verification email could not be sent. Please try later or contact a TVM administrator.')
    }
}

async function checkCode(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const code = interaction.fields.getTextInputValue('code').trim()
    if (!/^\d{6}$/.test(code)) {
        await privateReply(interaction, 'Enter the six-digit code from your email.')
        return
    }
    await withMembershipLock(async () => {
        const result = await store.verifyAndClaim(config.guildId, interaction.user.id, code)
        if (!result.ok) {
            const message = result.reason === 'claimed'
                ? 'This roster email is already linked to another account. Ask a TVM administrator for an account transfer.'
                : 'The code is invalid or expired. Request a new code if needed.'
            await privateReply(interaction, message)
            return
        }
        try {
            const member = await interaction.guild.members.fetch(interaction.user.id)
            await member.roles.add(config.memberRoleId)
        } catch (error) {
            // Discord may apply a role and lose the response. Keep the claim so an
            // ambiguous API failure can never leave an untracked member role.
            console.error('[TVM] Role assignment failed:', error?.message || error)
            await alertAdmins('A verification code was accepted, but role assignment failed. Check bot role hierarchy and permissions.')
            await privateReply(interaction, 'Your code was accepted, but role assignment could not be confirmed. Please contact a TVM administrator.')
            return
        }
        await privateReply(interaction, 'Verification complete. You now have the TVM membership role.')
    })
}

async function reconcile(guild) {
    const removed = await store.removedClaims(config.guildId)
    let revoked = 0
    let failed = 0
    for (const claim of removed) {
        try {
            const member = await guild.members.fetch(claim.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            if (member?.roles.cache.has(config.memberRoleId)) await member.roles.remove(config.memberRoleId)
            await store.releaseRemovedClaim(config.guildId, claim.email, claim.user_id)
            revoked++
        } catch (error) {
            console.error('[TVM] Role revocation failed:', error?.message || error)
            failed++
        }
    }
    // Administrators can assign roles manually. The bot owns this one role, so
    // remove it from any account without a current roster-backed claim too.
    const authorizedUsers = await store.activeClaimUserIds(config.guildId)
    let members
    try {
        members = await guild.members.fetch()
    } catch (error) {
        await alertAdmins('Role reconciliation could not fetch the server member list. Check Server Members Intent and bot access.')
        throw error
    }
    for (const member of members.values()) {
        if (!member.roles.cache.has(config.memberRoleId) || authorizedUsers.has(member.id)) continue
        try {
            await member.roles.remove(config.memberRoleId)
            revoked++
        } catch (error) {
            console.error('[TVM] Unclaimed role revocation failed:', error?.message || error)
            failed++
        }
    }
    if (failed) await alertAdmins(`${failed} removed roster claim(s) still need role revocation. Run /roster reconcile.`)
    return { revoked, failed }
}

async function handleRoster(interaction) {
    const subcommand = interaction.options.getSubcommand()
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (subcommand === 'status') {
        const status = await store.status(config.guildId)
        await privateReply(interaction, status.meta
            ? `Active roster: ${status.count} members, version ${status.meta.version}. Unreconciled removals: ${status.unreconciled}.`
            : 'No active roster. Verification is closed.')
        return
    }
    if (subcommand === 'audit') {
        const entries = await store.audit(config.guildId)
        await privateReply(interaction, entries.length ? entries.map(entry =>
            `${new Date(entry.at).toISOString()} • ${entry.action} • by ${/^\d{17,20}$/.test(entry.actor_id) ? `<@${entry.actor_id}>` : entry.actor_id} • ${entry.detail}`
        ).join('\n').slice(0, 1900) : 'No roster or transfer actions recorded.')
        return
    }
    if (subcommand === 'replace') {
        const attachment = interaction.options.getAttachment('csv')
        if (!attachment || attachment.size > 2 * 1024 * 1024) throw new Error('CSV must be 2 MiB or smaller')
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('Could not download the CSV attachment')
        const csv = await response.text()
        const rows = parseRoster(csv)
        const outcome = await withMembershipLock(async () => {
            const imported = await store.replaceRoster(config.guildId, rows, interaction.user.id)
            const reconciliation = await reconcile(interaction.guild)
            return { ...imported, ...reconciliation }
        })
        await privateReply(interaction, `Roster version ${outcome.version} activated with ${outcome.count} members. Roles revoked: ${outcome.revoked}. Revocations requiring retry: ${outcome.failed}.`)
        return
    }
    if (subcommand === 'reconcile') {
        const result = await withMembershipLock(() => reconcile(interaction.guild))
        await privateReply(interaction, `Roles revoked: ${result.revoked}. Revocations requiring retry: ${result.failed}.`)
        return
    }
    if (subcommand === 'repair') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address')
        await withMembershipLock(async () => {
            const roster = await store.lookup(config.guildId, email)
            const claim = await store.claimFor(config.guildId, email)
            if (!roster || !claim) throw new Error('No active roster claim exists for that email')
            const member = await interaction.guild.members.fetch(claim.user_id)
            await member.roles.add(config.memberRoleId)
            await privateReply(interaction, `Member role confirmed for <@${claim.user_id}>.`)
        })
        return
    }
    if (subcommand === 'release') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address')
        await withMembershipLock(async () => {
            const claim = await store.claimFor(config.guildId, email)
            if (!claim) throw new Error('No account is linked to that email')
            const member = await interaction.guild.members.fetch(claim.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            if (member?.roles.cache.has(config.memberRoleId)) await member.roles.remove(config.memberRoleId)
            await store.releaseClaim(config.guildId, email, interaction.user.id)
            await privateReply(interaction, `Claim released for <@${claim.user_id}>. They can verify again while on the active roster.`)
        })
        return
    }
    if (subcommand === 'transfer') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        const target = interaction.options.getUser('user')
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address')
        await withMembershipLock(async () => {
            const prior = await store.claimFor(config.guildId, email)
            if (!prior) throw new Error('No account is linked to that email')
            if (prior.user_id === target.id) throw new Error('That account already holds the claim')
            const targetMember = await interaction.guild.members.fetch(target.id)
            const oldMember = await interaction.guild.members.fetch(prior.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            if (oldMember) await oldMember.roles.remove(config.memberRoleId)
            try {
                await store.transfer(config.guildId, email, target.id, interaction.user.id)
            } catch (error) {
                if (oldMember) await oldMember.roles.add(config.memberRoleId).catch(() => {})
                throw error
            }
            try {
                await targetMember.roles.add(config.memberRoleId)
            } catch (error) {
                await alertAdmins('An account transfer changed the claim, but the new role could not be confirmed. Use /roster repair after checking permissions.')
                throw new Error('Claim transferred, but target role assignment could not be confirmed. Use /roster repair.')
            }
            await privateReply(interaction, `Account transfer complete for <@${target.id}>.`)
        })
    }
}

client.once('clientReady', async () => {
    try {
        await store.ready
        const rest = new REST({ version: '10' }).setToken(config.token)
        await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: commands })
        console.log('[TVM] Bot ready; guild commands registered')
        const guild = await client.guilds.fetch(config.guildId)
        const role = await guild.roles.fetch(config.memberRoleId)
        const botMember = await guild.members.fetchMe()
        if (!role || !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
            botMember.roles.highest.position <= role.position) {
            throw new Error('Bot cannot manage the configured membership role; check its permissions and role position')
        }
        const alertChannel = await client.channels.fetch(config.alertChannelId)
        if (!alertChannel?.isTextBased() || alertChannel.guildId !== guild.id ||
            !alertChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            throw new Error('Bot cannot send to its private administrator alert channel')
        }
        const result = await withMembershipLock(() => reconcile(guild))
        if (result.revoked) console.log(`[TVM] Reconciled ${result.revoked} removed claims`)
        setInterval(() => {
            store.sweep().catch(error => console.error('[TVM] Cleanup failed:', error?.message || error))
            withMembershipLock(() => reconcile(guild)).catch(error =>
                console.error('[TVM] Scheduled role reconciliation failed:', error?.message || error))
        }, 3600000).unref()
    } catch (error) {
        console.error('[TVM] Startup failed:', error?.message || error)
        await alertAdmins('Bot startup or roster reconciliation failed. Check bot logs.')
        client.destroy()
        process.exit(1)
    }
})

client.on('guildMemberUpdate', (before, after) => {
    if (after.guild.id !== config.guildId || !after.roles.cache.has(config.memberRoleId) ||
        before.roles.cache.has(config.memberRoleId)) return
    withMembershipLock(async () => {
        let authorized = false
        try {
            authorized = await store.isAuthorizedUser(config.guildId, after.id)
        } catch (error) {
            console.error('[TVM] Could not check newly granted role:', error?.message || error)
            await alertAdmins('Roster lookup failed while checking a member role grant. The role will be removed.')
        }
        if (!authorized) {
            await after.roles.remove(config.memberRoleId)
            await alertAdmins('The membership role was granted without an active roster claim and has been removed.')
        }
    }).catch(async error => {
        console.error('[TVM] Could not remove unclaimed role:', error?.message || error)
        await alertAdmins('Could not remove the membership role from an account without an active roster claim. Check bot permissions and run /roster reconcile.')
    })
})

client.on('interactionCreate', async interaction => {
    if (interaction.guildId !== config.guildId) return
    try {
        if (interaction.isButton()) {
            if (interaction.customId === 'tvm:verify') return await interaction.showModal(emailModal())
            if (interaction.customId === 'tvm:open-code') return await interaction.showModal(codeModal())
            return
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'tvm:email') return await sendVerification(interaction)
            if (interaction.customId === 'tvm:code') return await checkCode(interaction)
            return
        }
        if (!interaction.isChatInputCommand()) return
        if (interaction.commandName === 'verify') return await interaction.showModal(emailModal())
        if (interaction.commandName === 'source') {
            await interaction.reply({ content: 'Source code: https://github.com/TheTexta/tvm-discord-email-verification', flags: MessageFlags.Ephemeral })
            return
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
            return
        }
        if (interaction.commandName === 'roster') return await handleRoster(interaction)
        if (interaction.commandName === 'postverify') {
            await interaction.reply({ content: 'Posting the verification button.', flags: MessageFlags.Ephemeral })
            await interaction.channel.send({
                content: 'TVM members: click below and enter the email address on the TVM membership roster. We will email a verification code to that address. Source: https://github.com/TheTexta/tvm-discord-email-verification',
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('tvm:verify').setLabel('Verify TVM membership').setStyle(ButtonStyle.Success)
                )]
            })
            return
        }
        if (interaction.commandName === 'testmail') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            const email = interaction.options.getString('email').trim()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid destination email')
            await mail.sendMail({ fromName: 'TVM Verification', to: email,
                subject: 'TVM verification mail test', text: 'This is a test of the TVM Discord verification email sender.' })
            await privateReply(interaction, 'Test message accepted by SMTP. Check the destination inbox and junk folder.')
        }
    } catch (error) {
        console.error('[TVM] Interaction failed:', error?.message || error)
        const adminOperation = interaction.isChatInputCommand() && interaction.commandName !== 'verify' && interaction.commandName !== 'source'
        if (!adminOperation) await alertAdmins('A member verification interaction failed. Check the bot logs.')
        const message = adminOperation
            ? `Operation failed: ${String(error?.message || error).slice(0, 1500)}`
            : 'The operation failed. A TVM administrator should check the bot logs and try again.'
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, components: [] }).catch(() => {})
        else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {})
    }
})

client.login(config.token).catch(async error => {
    console.error('[TVM] Login failed:', error?.message || error)
    await store.close().catch(() => {})
    process.exit(1)
})
