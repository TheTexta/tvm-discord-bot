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
const { assertPrivateAlertChannel } = require('../shared/channelPermissions')
const { HealthReporter } = require('../infrastructure/HealthReporter')
const { uiText, validateUiText } = require('../shared/uiText')
const { canManageBot } = require('../shared/permissions')
const UnverifiedRoleManager = require('../membership/UnverifiedRoleManager')
const { ShootService } = require('../shoots/ShootService')
const { buildCommands } = require('./commands')
const { createMembershipService } = require('../membership/MembershipService')
const { createVerificationService } = require('../membership/VerificationService')
const { createRosterCommands } = require('../membership/RosterCommands')
const { roleKinds, configuredRoleIds } = require('../membership/roles')
const { normalizeEmail, validEmail } = require('../shared/validation')
const { modal: shootModal } = require('../shoots/forms')
const { emailModal, codeModal, codeRow } = require('../membership/verificationUi')

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
    validateUiText()
    // Build all interactive components now, including optional shoots, before connecting.
    emailModal().toJSON()
    codeModal().toJSON()
    codeRow().toJSON()
    buildCommands(true)
    shootModal({ id: 'validation', revision: 0, name: '', location: '', call_time: null, join_period: 'day' }).toJSON()
    shootModal(
        { id: 'validation', revision: 0, name: 'Shoot', location: 'Studio', call_time: null, join_period: 'day' },
        true
    ).toJSON()
    let state = 'starting'
    let resolveReady, rejectReady
    const readiness = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
    })
    // Shutdown or an initialization event can precede start().
    readiness.catch(() => {})
    let startPromise
    let stopping = false
    let shutdownPromise
    let healthReporter
    let alertReady = false
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
        if (!alertReady) {
            logger.error('[TVM] Administrator alert unavailable:', message)
            return
        }
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
    const shoots =
        shootService ||
        new ShootService({
            client,
            store: store.shoots || store,
            membershipStore: store.membership || store,
            config,
            alertAdmins
        })
    const privateReply = (interaction, content, components = []) => interaction.editReply({ content, components })
    const roleIds = configuredRoleIds(config)
    unverifiedRoles ||= new UnverifiedRoleManager(config.guildId, config.unverifiedRoleId, Object.values(roleIds))
    let unverifiedReady = false
    const membership = createMembershipService({
        config,
        store: store.membership || store,
        unverifiedRoles,
        alertAdmins,
        logger,
        withMembershipLock
    })
    const { roleNames, reconcile } = membership
    const { sendVerification, checkCode } = createVerificationService({
        config,
        store: store.membership || store,
        mail,
        withMembershipLock,
        membership,
        privateReply,
        alertAdmins,
        logger
    })
    const healthStatus = () => ({
        state,
        connected: state === 'ready' && (client.isReady?.() ?? true),
        membershipLastSuccessAt: membership.status().lastSuccessAt,
        shootsEnabled: Boolean(config.shoots),
        shootLastSuccessAt: shoots.lastSuccessAt ?? null
    })
    function scheduleReconciliation(guild) {
        return track(async () => {
            try {
                return await reconcile(guild)
            } finally {
                if (!stopping) await shoots.reconcileAll?.()
            }
        })
    }
    const { uploadRoster, handleRoster } = createRosterCommands({
        config,
        store: store.membership || store,
        withMembershipLock,
        membership,
        privateReply,
        unverifiedRoles,
        alertAdmins,
        scheduleReconciliation,
        healthStatus
    })

    listen(
        'clientReady',
        async () => {
            try {
                await store.ready
                if (stopping) return
                await store.sweep()
                if (stopping) return
                rest ||= new REST({ version: '10' }).setToken(config.token)
                const guild = await client.guilds.fetch(config.guildId)
                const roles = await Promise.all(roleKinds.map((kind) => guild.roles.fetch(roleIds[kind])))
                const botMember = await guild.members.fetchMe()
                if (
                    roles.some(
                        (role) =>
                            !role ||
                            role.id === guild.id ||
                            role.managed ||
                            botMember.roles.highest.position <= role.position
                    ) ||
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
                const allRoles = await guild.roles.fetch()
                await assertPrivateAlertChannel({
                    channel: {
                        type: alertChannel.type,
                        guild_id: alertChannel.guildId,
                        permission_overwrites: [...alertChannel.permissionOverwrites.cache.values()]
                    },
                    guild: { id: guild.id, owner_id: guild.ownerId },
                    roles: [...allRoles.values()],
                    botId: botMember.id,
                    adminRoleId: config.adminRoleId,
                    fetchMember: async (id) => {
                        const member = await guild.members.fetch({ user: id, force: true }).catch((error) => {
                            if (error.code === 10007) return null
                            throw error
                        })
                        return member ? { roles: [...member.roles.cache.keys()] } : null
                    }
                })
                alertReady = true
                if (stopping) return
                const unverifiedRole = await unverifiedRoles.initialize(guild)
                if (stopping) return
                unverifiedReady = true
                const result = await reconcile(guild)
                if (stopping) return
                await shoots.initialize()
                logger.log(
                    `[TVM] Unverified role ${unverifiedRole.id}: added ${result.unverified.added}, removed ${result.unverified.removed}, failed ${result.unverified.failed}`
                )
                if (result.revoked) logger.log(`[TVM] Reconciled ${result.revoked} removed claims`)
                if (stopping) return
                await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
                    body: commands
                })
                if (stopping) return
                state = 'ready'
                if (config.databasePath) {
                    healthReporter = new HealthReporter(config.databasePath, healthStatus, logger)
                    await healthReporter.start()
                    if (stopping) {
                        await healthReporter.stop()
                        return
                    }
                }
                resolveReady()
                logger.log('[TVM] Bot ready; guild commands registered')
                membershipTimer = setInterval(() => {
                    if (stopping) return
                    track(() => store.sweep()).catch((error) =>
                        logger.error('[TVM] Cleanup failed:', error?.message || error)
                    )
                    scheduleReconciliation(guild).catch((error) =>
                        logger.error('[TVM] Scheduled role reconciliation failed:', error?.message || error)
                    )
                }, 3600000).unref()
            } catch (error) {
                rejectReady(error)
                if (stopping) return
                logger.error('[TVM] Startup failed:', error?.message || error)
                await alertAdmins(uiText('alerts.startupFailed'))
                onFatal(error)
            }
        },
        true
    )

    async function syncUnverifiedMember(member) {
        if (state !== 'ready' || !unverifiedReady || member.guild.id !== config.guildId) return
        try {
            await withMembershipLock(() => unverifiedRoles.syncMember(member))
        } catch (error) {
            logger.error('[TVM] Member Unverified role sync failed:', error?.message || error)
            await alertAdmins(uiText('alerts.unverifiedFailed'))
        }
    }

    listen('guildMemberAdd', async (member) => {
        if (state !== 'ready' || member.guild.id !== config.guildId || member.user.bot) return
        await membership.syncUser(member.guild, member.id)
        await shoots.reconcileAll?.()
    })
    listen('guildMemberUpdate', (_oldMember, member) => syncUnverifiedMember(member))
    listen('messageReactionAdd', (reaction, user) => state === 'ready' && shoots.onReaction(reaction, user))
    listen('messageReactionRemove', (reaction, user) => state === 'ready' && shoots.onReaction(reaction, user))
    listen('messageReactionRemoveAll', (message) => state === 'ready' && shoots.onReactionClear(message))
    listen(
        'messageReactionRemoveEmoji',
        (reaction) => state === 'ready' && shoots.onReactionClear(reaction.message, reaction.emoji)
    )
    async function reconnect() {
        if (state !== 'ready' || stopping) return
        await scheduleReconciliation(await client.guilds.fetch(config.guildId))
    }
    listen('shardResume', reconnect)
    listen('shardReady', reconnect)
    listen('shardError', (error) => logger.error('[TVM] Discord connection failed:', error.message))

    listen('interactionCreate', async (interaction) => {
        if (interaction.guildId !== config.guildId) return
        try {
            if (interaction.isChatInputCommand() && interaction.commandName === 'source') {
                await interaction.reply({ content: uiText('verification.source'), flags: MessageFlags.Ephemeral })
                return
            }
            if (state !== 'ready') {
                await interaction.reply({ content: uiText('verification.starting'), flags: MessageFlags.Ephemeral })
                return
            }
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
            if (!canManageBot(interaction, config.adminRoleId)) {
                await interaction.reply({ content: uiText('admin.permissionRequired'), flags: MessageFlags.Ephemeral })
                return
            }
            if (interaction.commandName === 'upload') return await uploadRoster(interaction)
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
        startPromise ||= track(async () => {
            await client.login(config.token)
            await readiness
        })
        return startPromise
    }

    function shutdown() {
        if (shutdownPromise) return shutdownPromise
        stopping = true
        state = 'stopping'
        rejectReady(new Error('Application is stopping'))
        clearInterval(membershipTimer)
        shoots.stop()
        membership.stop()
        for (const [event, listener] of listeners) client.off(event, listener)
        let timer
        const drain = (async () => {
            try {
                await Promise.allSettled([...active])
                await membershipQueue
                await membership.drain()
                await healthReporter?.stop()
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

    return { commands, start, shutdown, healthStatus }
}

module.exports = { createApp }
