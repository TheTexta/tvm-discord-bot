// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const {
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, MessageFlags
} = require('discord.js')
const { loadConfig } = require('./config')
const { uiText } = require('./uiText')
const { canManageBot } = require('./permissions')
const { parseRoster } = require('./roster')
const Store = require('./Store')
const UnverifiedRoleManager = require('./UnverifiedRoleManager')
const { ShootService, shootCommand, partials: shootPartials } = require('./ShootService')
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
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
        ...(config.shoots ? [GatewayIntentBits.GuildMessageReactions] : [])],
    partials: config.shoots ? shootPartials : []
})
const lastAlertAt = new Map()
async function alertAdmins(message) {
    const now = Date.now()
    if (now - (lastAlertAt.get(message) || 0) < 5 * 60000) return
    lastAlertAt.set(message, now)
    try {
        const channel = await client.channels.fetch(config.alertChannelId)
        if (channel?.isTextBased()) await channel.send({ content: uiText('alerts.message', { message }) })
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
    new SlashCommandBuilder().setName('verify').setDescription(uiText('commands.verify')),
    new SlashCommandBuilder().setName('source').setDescription(uiText('commands.source')),
    new SlashCommandBuilder().setName('postverify').setDescription(uiText('commands.postverify'))
        .setDefaultMemberPermissions(null),
    new SlashCommandBuilder().setName('testmail').setDescription(uiText('commands.testmail'))
        .setDefaultMemberPermissions(null)
        .addStringOption(o => o.setName('email').setDescription(uiText('commands.destinationEmail')).setRequired(true)),
    new SlashCommandBuilder().setName('upload').setDescription(uiText('commands.upload'))
        .setDefaultMemberPermissions(null)
        .addAttachmentOption(o => o.setName('csv').setDescription(uiText('commands.csv')).setRequired(true)),
    new SlashCommandBuilder().setName('roster').setDescription(uiText('commands.roster'))
        .setDefaultMemberPermissions(null)
        .addSubcommand(s => s.setName('status').setDescription(uiText('commands.status')))
        .addSubcommand(s => s.setName('audit').setDescription(uiText('commands.audit')))
        .addSubcommand(s => s.setName('reconcile').setDescription(uiText('commands.reconcile')))
        .addSubcommand(s => s.setName('repair').setDescription(uiText('commands.repair'))
            .addStringOption(o => o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true)))
        .addSubcommand(s => s.setName('release').setDescription(uiText('commands.release'))
            .addStringOption(o => o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true)))
        .addSubcommand(s => s.setName('transfer').setDescription(uiText('commands.transfer'))
            .addStringOption(o => o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true))
            .addUserOption(o => o.setName('user').setDescription(uiText('commands.newAccount')).setRequired(true)))
].map(command => command.toJSON())
if (config.shoots) commands.push(shootCommand())
const shoots = new ShootService({ client, store, config, alertAdmins })

const privateReply = (interaction, content, components = []) => interaction.editReply({ content, components })
const roleKinds = ['member', 'exec', 'admin']
const roleIds = { member: config.memberRoleId, exec: config.execRoleId, admin: config.adminRoleId }
const unverifiedRoles = new UnverifiedRoleManager(config.guildId, config.unverifiedRoleId, Object.values(roleIds))
let unverifiedReady = false
const roleNames = { member: uiText('roles.member'), exec: uiText('roles.exec'), admin: uiText('roles.admin') }
const managedColumns = { member: 'managed_role', exec: 'managed_exec_role', admin: 'managed_admin_role' }
const desiredKinds = role => role === 'exec' ? ['member', 'exec'] : role === 'admin' ? ['member', 'admin'] : ['member']
const existingRoles = member => Object.fromEntries(roleKinds.map(kind => [kind, member.roles.cache.has(roleIds[kind])]))
const roleSummary = role => desiredKinds(role).map(kind => roleNames[kind]).join(uiText('roles.separator'))

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
const codeRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tvm:open-code').setLabel(uiText('buttons.enterCode')).setStyle(ButtonStyle.Primary)
)

function emailModal() {
    return new ModalBuilder().setCustomId('tvm:email').setTitle(uiText('modals.emailTitle'))
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('email').setLabel(uiText('modals.emailLabel'))
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(254)
        ))
}

function codeModal() {
    return new ModalBuilder().setCustomId('tvm:code').setTitle(uiText('modals.codeTitle'))
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('code').setLabel(uiText('modals.codeLabel'))
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
        await privateReply(interaction, uiText('verification.invalidEmail'))
        return
    }
    const status = await store.status(config.guildId)
    if (!status.meta || status.count === 0) {
        await privateReply(interaction, uiText('verification.unavailable'))
        return
    }
    if (!await store.allowRequest(config.guildId, interaction.user.id, email)) {
        await privateReply(interaction, uiText('verification.rateLimited'))
        return
    }
    const row = await store.lookup(config.guildId, email)
    const generic = uiText('verification.codeSent')
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
            fromName: uiText('email.fromName'), to: row.email, subject: uiText('email.codeSubject'),
            text: uiText('email.codeBody', { code })
        })
        await store.savePending(config.guildId, interaction.user.id, row.email, code)
        await privateReply(interaction, generic, [codeRow()])
    } catch (error) {
        console.error('[TVM] Verification email failed:', error?.message || error)
        await alertAdmins(uiText('alerts.emailFailed'))
        await privateReply(interaction, uiText('verification.emailFailed'))
    }
}

async function checkCode(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const code = interaction.fields.getTextInputValue('code').trim()
    if (!/^\d{6}$/.test(code)) {
        await privateReply(interaction, uiText('verification.invalidCodeFormat'))
        return
    }
    await withMembershipLock(async () => {
        const member = await interaction.guild.members.fetch(interaction.user.id)
        const result = await store.verifyAndClaim(config.guildId, interaction.user.id, code, existingRoles(member))
        if (!result.ok) {
            const message = result.reason === 'claimed'
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
            console.error('[TVM] Role assignment failed:', error?.message || error)
            await alertAdmins(uiText('alerts.roleFailed'))
            await privateReply(interaction, uiText('verification.roleFailed'))
            return
        }
        await privateReply(interaction, uiText('verification.complete', { roles: roleSummary(result.role) }))
    })
}

async function reconcile(guild) {
    const removed = config.autoRoleRevocation ? await store.removedClaims(config.guildId) : []
    let revoked = 0
    let failed = 0
    for (const claim of removed) {
        try {
            const member = await guild.members.fetch(claim.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            revoked += await removeManagedRoles(member, claim)
            await store.releaseRemovedClaim(config.guildId, claim.email, claim.user_id)
        } catch (error) {
            console.error('[TVM] Role revocation failed:', error?.message || error)
            failed++
        }
    }
    const active = await store.activeClaims(config.guildId)
    for (const claim of active) {
        try {
            const member = await guild.members.fetch(claim.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            if (!member) continue
            const unwanted = config.autoRoleRevocation
                ? roleKinds.filter(kind => !desiredKinds(claim.role).includes(kind)) : []
            revoked += await removeManagedRoles(member, claim, unwanted)
            for (const kind of unwanted) {
                if (claim[managedColumns[kind]]) await store.clearRoleManaged(config.guildId, claim.email, claim.user_id, kind)
            }
            await addMissingRoles(member, claim.email, claim.role)
        } catch (error) {
            console.error('[TVM] Active claim role sync failed:', error?.message || error)
            failed++
        }
    }
    // Existing server role assignments are outside this bot's ownership.
    const unverified = await unverifiedRoles.syncGuild(guild)
    if (unverified.failed) await alertAdmins(uiText('alerts.unverifiedSync', { failed: unverified.failed }))
    if (failed) await alertAdmins(uiText('alerts.claimSync', { failed }))
    return { revoked, failed, unverified }
}

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
        await privateReply(interaction, status.meta
            ? uiText('admin.status', { count: status.count, version: status.meta.version, unreconciled: status.unreconciled })
            : uiText('admin.noRoster'))
        return
    }
    if (subcommand === 'audit') {
        const entries = await store.audit(config.guildId)
        await privateReply(interaction, entries.length ? entries.map(entry =>
            uiText('admin.auditEntry', {
                timestamp: new Date(entry.at).toISOString(),
                action: uiText(`auditActions.${entry.action}`),
                actor: /^\d{17,20}$/.test(entry.actor_id) ? `<@${entry.actor_id}>` : entry.actor_id,
                detail: entry.detail
            })
        ).join('\n').slice(0, 1900) : uiText('admin.noAudit'))
        return
    }
    if (subcommand === 'reconcile') {
        const result = await withMembershipLock(() => reconcile(interaction.guild))
        await privateReply(interaction, uiText('admin.reconciled', {
            revoked: result.revoked, failed: result.failed, added: result.unverified.added,
            removed: result.unverified.removed, unverifiedFailed: result.unverified.failed
        }))
        return
    }
    if (subcommand === 'repair') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(uiText('errors.invalidEmail'))
        await withMembershipLock(async () => {
            const roster = await store.lookup(config.guildId, email)
            const claim = await store.claimFor(config.guildId, email)
            if (!roster || !claim) throw new Error(uiText('errors.noActiveClaim'))
            const member = await interaction.guild.members.fetch(claim.user_id)
            await addMissingRoles(member, email, roster.role)
            await privateReply(interaction, uiText('admin.repaired', { roles: roleSummary(roster.role), userId: claim.user_id }))
        })
        return
    }
    if (subcommand === 'release') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(uiText('errors.invalidEmail'))
        await withMembershipLock(async () => {
            const claim = await store.claimFor(config.guildId, email)
            if (!claim) throw new Error(uiText('errors.noLinkedAccount'))
            const member = await interaction.guild.members.fetch(claim.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            await removeManagedRoles(member, claim)
            await store.releaseClaim(config.guildId, email, interaction.user.id)
            if (member) await unverifiedRoles.syncMember(await interaction.guild.members.fetch({ user: member.id, force: true }))
            await privateReply(interaction, uiText('admin.released', { userId: claim.user_id }))
        })
        return
    }
    if (subcommand === 'transfer') {
        const email = interaction.options.getString('email').trim().toLowerCase()
        const target = interaction.options.getUser('user')
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(uiText('errors.invalidEmail'))
        await withMembershipLock(async () => {
            const prior = await store.claimFor(config.guildId, email)
            if (!prior) throw new Error(uiText('errors.noLinkedAccount'))
            if (prior.user_id === target.id) throw new Error(uiText('errors.sameAccount'))
            const targetMember = await interaction.guild.members.fetch(target.id)
            const oldMember = await interaction.guild.members.fetch(prior.user_id).catch(error => {
                if (error.code === 10007) return null
                throw error
            })
            const roster = await store.lookup(config.guildId, email)
            const oldRoles = oldMember ? roleKinds.filter(kind => prior[managedColumns[kind]] && oldMember.roles.cache.has(roleIds[kind])) : []
            try {
                await removeManagedRoles(oldMember, prior)
            } catch (error) {
                for (const kind of oldRoles) await oldMember.roles.add(roleIds[kind]).catch(() => {})
                throw error
            }
            try {
                await store.transfer(config.guildId, email, target.id, interaction.user.id, existingRoles(targetMember))
            } catch (error) {
                for (const kind of oldRoles) await oldMember.roles.add(roleIds[kind]).catch(() => {})
                throw error
            }
            try {
                await addMissingRoles(targetMember, email, roster.role)
                if (oldMember) await unverifiedRoles.syncMember(await interaction.guild.members.fetch({ user: oldMember.id, force: true }))
            } catch (error) {
                await alertAdmins(uiText('alerts.transferFailed'))
                throw new Error(uiText('errors.transferRoleFailed'))
            }
            await privateReply(interaction, uiText('admin.transferred', { userId: target.id }))
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
        const roles = await Promise.all(roleKinds.map(kind => guild.roles.fetch(roleIds[kind])))
        const botMember = await guild.members.fetchMe()
        if (roles.some(role => !role || botMember.roles.highest.position <= role.position) ||
            !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            throw new Error('Bot cannot manage all configured roles; check its permissions and role position')
        }
        const alertChannel = await client.channels.fetch(config.alertChannelId)
        if (!alertChannel?.isTextBased() || alertChannel.guildId !== guild.id ||
            !alertChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            throw new Error('Bot cannot send to its private administrator alert channel')
        }
        const unverifiedRole = await unverifiedRoles.initialize(guild)
        unverifiedReady = true
        const result = await withMembershipLock(() => reconcile(guild))
        await shoots.initialize()
        console.log(`[TVM] Unverified role ${unverifiedRole.id}: added ${result.unverified.added}, removed ${result.unverified.removed}, failed ${result.unverified.failed}`)
        if (result.revoked) console.log(`[TVM] Reconciled ${result.revoked} removed claims`)
        setInterval(() => {
            store.sweep().catch(error => console.error('[TVM] Cleanup failed:', error?.message || error))
            withMembershipLock(() => reconcile(guild)).catch(error =>
                console.error('[TVM] Scheduled role reconciliation failed:', error?.message || error))
        }, 3600000).unref()
    } catch (error) {
        console.error('[TVM] Startup failed:', error?.message || error)
        await alertAdmins(uiText('alerts.startupFailed'))
        client.destroy()
        process.exit(1)
    }
})

async function syncUnverifiedMember(member) {
    if (!unverifiedReady || member.guild.id !== config.guildId) return
    try {
        await withMembershipLock(() => unverifiedRoles.syncMember(member))
    } catch (error) {
        console.error('[TVM] Member Unverified role sync failed:', error?.message || error)
        await alertAdmins(uiText('alerts.unverifiedFailed'))
    }
}

client.on('guildMemberAdd', syncUnverifiedMember)
client.on('guildMemberUpdate', (_oldMember, member) => syncUnverifiedMember(member))
client.on('messageReactionAdd', (reaction, user) => shoots.onReaction(reaction, user))
client.on('messageReactionRemove', (reaction, user) => shoots.onReaction(reaction, user))
client.on('messageReactionRemoveAll', message => shoots.onReactionClear(message))
client.on('messageReactionRemoveEmoji', reaction => shoots.onReactionClear(reaction.message, reaction.emoji))
client.on('shardResume', () => shoots.reconcileAll().catch(error => shoots.report('resume', error)))
client.on('shardReady', () => {
    if (shoots.timer) shoots.reconcileAll().catch(error => shoots.report('reconnect', error))
})

client.on('interactionCreate', async interaction => {
    if (interaction.guildId !== config.guildId) return
    try {
        if (await shoots.handleInteraction(interaction)) return
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
            await interaction.reply({ content: uiText('verification.source'), flags: MessageFlags.Ephemeral })
            return
        }
        if (!canManageBot(interaction, config.adminRoleId)) {
            await interaction.reply({ content: uiText('admin.permissionRequired'), flags: MessageFlags.Ephemeral })
            return
        }
        if (interaction.commandName === 'upload') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            return await uploadRoster(interaction)
        }
        if (interaction.commandName === 'roster') return await handleRoster(interaction)
        if (interaction.commandName === 'postverify') {
            await interaction.reply({ content: uiText('verification.posting'), flags: MessageFlags.Ephemeral })
            await interaction.channel.send({
                content: uiText('verification.post', { memberRole: roleNames.member, execRole: roleNames.exec, adminRole: roleNames.admin }),
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('tvm:verify').setLabel(uiText('buttons.verify')).setStyle(ButtonStyle.Success)
                )]
            })
            return
        }
        if (interaction.commandName === 'testmail') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            const email = interaction.options.getString('email').trim()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(uiText('errors.invalidDestination'))
            await mail.sendMail({ fromName: uiText('email.fromName'), to: email,
                subject: uiText('email.testSubject'), text: uiText('email.testBody') })
            await privateReply(interaction, uiText('admin.testmailSent'))
        }
    } catch (error) {
        console.error('[TVM] Interaction failed:', error?.message || error)
        const adminOperation = interaction.isChatInputCommand() && interaction.commandName !== 'verify' && interaction.commandName !== 'source'
        if (!adminOperation) await alertAdmins(uiText('alerts.interactionFailed'))
        const message = adminOperation
            ? uiText('admin.operationFailed', { error: String(error?.message || error).slice(0, 1500) })
            : uiText('verification.failed')
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, components: [] }).catch(() => {})
        else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {})
    }
})

client.login(config.token).catch(async error => {
    console.error('[TVM] Login failed:', error?.message || error)
    await store.close().catch(() => {})
    process.exit(1)
})
