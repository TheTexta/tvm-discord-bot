// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const {
    REST,
    Routes,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js')
const { uiText } = require('./uiText')
const { canManageBot } = require('./permissions')
const UnverifiedRoleManager = require('./UnverifiedRoleManager')
const { ShootService } = require('./ShootService')
const { buildCommands } = require('./commands')
const { createMembershipService } = require('./MembershipService')
const { createVerificationService } = require('./VerificationService')
const { createRosterCommands } = require('./RosterCommands')
const { roleKinds, configuredRoleIds } = require('./roles')
const { normalizeEmail, validEmail } = require('./validation')
const { emailModal, codeModal } = require('./verificationUi')

function createApp({
    config,
    store,
    mail,
    client,
    unverifiedRoles,
    shoots: shootService,
    rest,
    logger = console,
    onFatal = () => {},
    shutdownTimeoutMs = 25000
}) {
    if (!config || !store || !mail || !client) throw new Error('Application dependencies are required')
    let stopping = false
    let shutdownPromise
    let membershipTimer
    const active = new Set()
    const listeners = []
    function track(work) {
        const job = Promise.resolve().then(work)
        active.add(job)
        job.then(
            () => active.delete(job),
            () => active.delete(job)
        )
        return job
    }
    function listen(event, handler, once = false) {
        const listener = (...args) => {
            if (stopping) return Promise.resolve()
            const job = track(() => handler(...args))
            job.catch((error) => logger.error(`[TVM] ${event} failed:`, error?.message || error))
            return job
        }
        client[once ? 'once' : 'on'](event, listener)
        listeners.push([event, listener])
    }
    const lastAlertAt = new Map()
    async function alertAdmins(message) {
        const now = Date.now()
        if (now - (lastAlertAt.get(message) || 0) < 5 * 60000) return
        lastAlertAt.set(message, now)
        try {
            const channel = await client.channels.fetch(config.alertChannelId)
            if (channel?.isTextBased()) await channel.send({ content: uiText('alerts.message', { message }) })
        } catch (error) {
            logger.error('[TVM] Could not send administrator alert:', error?.message || error)
        }
    }
    let membershipQueue = Promise.resolve()
    function withMembershipLock(work) {
        const next = membershipQueue.then(work)
        membershipQueue = next.catch(() => {})
        return next
    }

    const commands = buildCommands(Boolean(config.shoots))
    const shoots = shootService || new ShootService({ client, store, config, alertAdmins })
    const privateReply = (interaction, content, components = []) => interaction.editReply({ content, components })
    const roleIds = configuredRoleIds(config)
    unverifiedRoles ||= new UnverifiedRoleManager(config.guildId, config.unverifiedRoleId, Object.values(roleIds))
    let unverifiedReady = false
    const membership = createMembershipService({ config, store, unverifiedRoles, alertAdmins, logger })
    const { roleNames, reconcile } = membership
    const { sendVerification, checkCode } = createVerificationService({
        config,
        store,
        mail,
        withMembershipLock,
        membership,
        privateReply,
        alertAdmins,
        logger
    })
    const { uploadRoster, handleRoster } = createRosterCommands({
        config,
        store,
        withMembershipLock,
        membership,
        privateReply,
        unverifiedRoles,
        alertAdmins
    })

    listen(
        'clientReady',
        async () => {
            try {
                await store.ready
                rest ||= new REST({ version: '10' }).setToken(config.token)
                await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
                    body: commands
                })
                logger.log('[TVM] Bot ready; guild commands registered')
                const guild = await client.guilds.fetch(config.guildId)
                const roles = await Promise.all(roleKinds.map((kind) => guild.roles.fetch(roleIds[kind])))
                const botMember = await guild.members.fetchMe()
                if (
                    roles.some((role) => !role || botMember.roles.highest.position <= role.position) ||
                    !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
                ) {
                    throw new Error('Bot cannot manage all configured roles; check its permissions and role position')
                }
                const alertChannel = await client.channels.fetch(config.alertChannelId)
                if (
                    !alertChannel?.isTextBased() ||
                    alertChannel.guildId !== guild.id ||
                    !alertChannel
                        .permissionsFor(botMember)
                        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
                ) {
                    throw new Error('Bot cannot send to its private administrator alert channel')
                }
                const unverifiedRole = await unverifiedRoles.initialize(guild)
                unverifiedReady = true
                const result = await withMembershipLock(() => reconcile(guild))
                await shoots.initialize()
                logger.log(
                    `[TVM] Unverified role ${unverifiedRole.id}: added ${result.unverified.added}, removed ${result.unverified.removed}, failed ${result.unverified.failed}`
                )
                if (result.revoked) logger.log(`[TVM] Reconciled ${result.revoked} removed claims`)
                if (stopping) return
                membershipTimer = setInterval(() => {
                    if (stopping) return
                    track(() => store.sweep()).catch((error) =>
                        logger.error('[TVM] Cleanup failed:', error?.message || error)
                    )
                    track(() => withMembershipLock(() => reconcile(guild))).catch((error) =>
                        logger.error('[TVM] Scheduled role reconciliation failed:', error?.message || error)
                    )
                }, 3600000).unref()
            } catch (error) {
                logger.error('[TVM] Startup failed:', error?.message || error)
                await alertAdmins(uiText('alerts.startupFailed'))
                onFatal(error)
            }
        },
        true
    )

    async function syncUnverifiedMember(member) {
        if (!unverifiedReady || member.guild.id !== config.guildId) return
        try {
            await withMembershipLock(() => unverifiedRoles.syncMember(member))
        } catch (error) {
            logger.error('[TVM] Member Unverified role sync failed:', error?.message || error)
            await alertAdmins(uiText('alerts.unverifiedFailed'))
        }
    }

    listen('guildMemberAdd', syncUnverifiedMember)
    listen('guildMemberUpdate', (_oldMember, member) => syncUnverifiedMember(member))
    listen('messageReactionAdd', (reaction, user) => shoots.onReaction(reaction, user))
    listen('messageReactionRemove', (reaction, user) => shoots.onReaction(reaction, user))
    listen('messageReactionRemoveAll', (message) => shoots.onReactionClear(message))
    listen('messageReactionRemoveEmoji', (reaction) => shoots.onReactionClear(reaction.message, reaction.emoji))
    listen('shardResume', () => shoots.reconcileAll().catch((error) => shoots.report('resume', error)))
    listen('shardReady', () => {
        if (shoots.timer) shoots.reconcileAll().catch((error) => shoots.report('reconnect', error))
    })

    listen('interactionCreate', async (interaction) => {
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
                    content: uiText('verification.post', {
                        memberRole: roleNames.member,
                        execRole: roleNames.exec,
                        adminRole: roleNames.admin
                    }),
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('tvm:verify')
                                .setLabel(uiText('buttons.verify'))
                                .setStyle(ButtonStyle.Success)
                        )
                    ]
                })
                return
            }
            if (interaction.commandName === 'testmail') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                const email = normalizeEmail(interaction.options.getString('email'))
                if (!validEmail(email)) throw new Error(uiText('errors.invalidDestination'))
                await mail.sendMail({
                    fromName: uiText('email.fromName'),
                    to: email,
                    subject: uiText('email.testSubject'),
                    text: uiText('email.testBody')
                })
                await privateReply(interaction, uiText('admin.testmailSent'))
            }
        } catch (error) {
            logger.error('[TVM] Interaction failed:', error?.message || error)
            const adminOperation =
                interaction.isChatInputCommand() &&
                interaction.commandName !== 'verify' &&
                interaction.commandName !== 'source'
            if (!adminOperation) await alertAdmins(uiText('alerts.interactionFailed'))
            const message = adminOperation
                ? uiText('admin.operationFailed', { error: String(error?.message || error).slice(0, 1500) })
                : uiText('verification.failed')
            if (interaction.deferred || interaction.replied)
                await interaction.editReply({ content: message, components: [] }).catch(() => {})
            else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {})
        }
    })

    function start() {
        if (stopping) return Promise.reject(new Error('Application is stopping'))
        return track(() => client.login(config.token))
    }

    function shutdown() {
        if (shutdownPromise) return shutdownPromise
        stopping = true
        clearInterval(membershipTimer)
        shoots.stop()
        for (const [event, listener] of listeners) client.off(event, listener)
        let timer
        const drain = (async () => {
            try {
                await Promise.allSettled([...active])
                await membershipQueue
                await shoots.drain()
                await mail.close?.()
                await store.close()
            } finally {
                await client.destroy()
            }
        })()
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                mail.close?.()
                client.destroy()
                reject(new Error(`Shutdown exceeded ${shutdownTimeoutMs} ms`))
            }, shutdownTimeoutMs)
        })
        shutdownPromise = Promise.race([drain, deadline]).finally(() => clearTimeout(timer))
        return shutdownPromise
    }

    return { commands, start, shutdown }
}

module.exports = { createApp }
