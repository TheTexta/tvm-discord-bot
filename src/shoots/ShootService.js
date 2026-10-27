// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const {
    ChannelType,
    Partials,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js')
const { uiText } = require('../shared/uiText')
const ShootResources = require('./ShootResources')
const ShootInputError = require('./ShootInputError')
const { ShootFailureReporter } = require('./ShootFailureReporter')
const { isBotAdmin, canManageBot } = require('../shared/permissions')
const {
    EMOJI,
    BOT_PERMISSIONS,
    ANNOUNCEMENT_PERMISSIONS,
    ACTIVE_STATUSES,
    noMentions,
    joinDeadline,
    joiningAllowed,
    overwrites,
    overwriteKey
} = require('./policy')
const { parseMembers, parseDetails, shootCommand, modal } = require('./forms')
const { memberFields } = require('./render')

class ShootService {
    constructor({ client, store, config, alertAdmins, logger = console, now = Date.now }) {
        this.client = client
        this.store = store
        this.config = config
        this.settings = config.shoots
        this.alertAdmins = alertAdmins
        this.failures = new ShootFailureReporter({ alertAdmins, logger, now })
        this.locks = new Map()
        this.running = false
        this.stopped = false
        this.resources = new ShootResources(this)
        this.forms = new Map()
        this.reactionJobs = new Map()
        this.lastSuccessAt = null
        this.reconcileRequested = false
        this.republishRequested = false
    }

    withLock(id, work) {
        const previous = this.locks.get(id) || Promise.resolve()
        const next = previous.catch(() => {}).then(work)
        this.locks.set(id, next)
        return next.finally(() => {
            if (this.locks.get(id) === next) this.locks.delete(id)
        })
    }

    report(id, error, context) {
        return this.failures.failure(id, error, context)
    }

    operation(name, work) {
        return this.failures.operation(name, work)
    }

    async initialize() {
        if (!this.settings || this.stopped) return
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const bot = await guild.members.fetchMe()
        const productionRole = this.config.productionAccessRoleId
            ? await guild.roles.fetch(this.config.productionAccessRoleId)
            : null
        if (
            !productionRole ||
            productionRole.id === guild.id ||
            productionRole.managed ||
            productionRole.permissions.bitfield !== 0n ||
            bot.roles.highest.comparePositionTo(productionRole) <= 0
        ) {
            throw new Error(
                'TVM_PRODUCTION_ACCESS_ROLE_ID must identify a separate, manageable role with no server-wide permissions'
            )
        }
        for (const [id, type, permissions] of [
            [this.settings.announcementChannelId, ChannelType.GuildText, ANNOUNCEMENT_PERMISSIONS],
            [this.settings.categoryId, ChannelType.GuildCategory, BOT_PERMISSIONS],
            [this.settings.archiveCategoryId, ChannelType.GuildCategory, BOT_PERMISSIONS]
        ]) {
            const channel = await guild.channels.fetch(id)
            if (
                !channel ||
                channel.guildId !== guild.id ||
                channel.type !== type ||
                !channel.permissionsFor(bot)?.has(permissions)
            ) {
                throw new Error(uiText('shoot.configError'))
            }
        }
        await this.reconcileAll({ republishAnnouncements: true })
        if (this.stopped) return
        // reconcileAll reports its own failures, regardless of which trigger called it.
        this.timer = setInterval(() => this.reconcileAll().catch(() => {}), 60000)
        this.timer.unref()
    }

    stop() {
        this.stopped = true
        clearInterval(this.timer)
        this.forms.clear()
        for (const job of this.reactionJobs.values()) {
            clearTimeout(job.timer)
            job.run()
        }
    }

    async drain() {
        await Promise.allSettled([
            this.reconciliation,
            ...[...this.reactionJobs.values()].map((job) => job.promise),
            ...this.locks.values()
        ])
    }

    membersForPass(guild) {
        const members = new Map()
        return (userId) => {
            if (!members.has(userId)) {
                const fetched = this.operation('fetch_member', () =>
                    guild.members.fetch({ user: userId, force: true })
                ).catch((error) => {
                    if (error.code === 10007) return null
                    members.delete(userId)
                    throw error
                })
                members.set(userId, fetched)
            }
            return members.get(userId)
        }
    }

    async eligible(guild, userId, members = this.membersForPass(guild)) {
        const member = await members(userId)
        return Boolean(
            member &&
            !member.user.bot &&
            (isBotAdmin(member, this.config.adminRoleId) ||
                member.roles.cache.has(this.config.memberRoleId) ||
                member.roles.cache.has(this.config.execRoleId))
        )
    }

    hasProductionAccess(member) {
        return Boolean(member?.roles?.cache?.has(this.config.productionAccessRoleId) || isBotAdmin(member, null))
    }

    async handleInteraction(interaction) {
        const isCommand = interaction.isChatInputCommand() && interaction.commandName === 'shoot'
        const isModal = interaction.isModalSubmit() && interaction.customId.startsWith('tvm:shoot:')
        const isForm = interaction.isButton?.() && interaction.customId.startsWith('tvm:shoot:form:')
        if (!isCommand && !isModal && !isForm) return false
        if (interaction.guildId !== this.config.guildId) return true
        await this.failures.run(
            {
                shootId: isModal ? interaction.customId.split(':')[3] : null,
                channelId: interaction.channelId,
                workflow: `command:${isCommand ? interaction.options.getSubcommand() : isModal ? 'submit' : 'form'}`,
                trigger: 'command',
                operation: 'command',
                retrying: false
            },
            async () => {
                try {
                    // Do not trust command defaults or a previously authorized form.
                    if (!canManageBot(interaction, this.config.adminRoleId)) {
                        await interaction.reply({ content: uiText('shoot.permission'), flags: MessageFlags.Ephemeral })
                        return true
                    }
                    if (!this.settings) throw new ShootInputError(uiText('shoot.disabled'))
                    if (interaction.channel?.type !== ChannelType.GuildText)
                        throw new ShootInputError(uiText('shoot.notText'))
                    if (isForm)
                        await this.operation('show_form', () => interaction.showModal(this.openForm(interaction)))
                    else if (isModal) await this.submitModal(interaction)
                    else await this.command(interaction)
                    await this.failures.recovered(this.failures.context.getStore())
                } catch (error) {
                    const context = this.failures.context.getStore()
                    let content
                    if (error instanceof ShootInputError && !context.persisted) {
                        content = uiText('admin.operationFailed', { error: error.message })
                    } else {
                        const reference = await this.report(context.shootId, this.failures.capture(error))
                        content = uiText(
                            context.persisted
                                ? context.synchronized
                                    ? 'shoot.confirmationFailed'
                                    : 'shoot.syncPending'
                                : 'shoot.actionFailed',
                            { reference: reference || 'unavailable' }
                        )
                    }
                    const payload = {
                        content,
                        components: [],
                        allowedMentions: noMentions
                    }
                    if (interaction.deferred || interaction.replied)
                        await interaction.editReply(payload).catch(() => {})
                    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {})
                }
            }
        )
        return true
    }

    async prepareForm(interaction, shoot, edit = false) {
        const now = Date.now()
        for (const [token, value] of this.forms) if (value.expiresAt <= now) this.forms.delete(token)
        const token = crypto.randomUUID()
        this.forms.set(token, {
            shoot: { ...shoot },
            edit,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            expiresAt: now + 30 * 60000
        })
        await interaction.editReply({
            content: uiText('shoot.formReady'),
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`tvm:shoot:form:${token}`)
                        .setLabel(uiText('shoot.openForm'))
                        .setStyle(ButtonStyle.Primary)
                )
            ],
            allowedMentions: noMentions
        })
    }

    openForm(interaction) {
        const token = interaction.customId.split(':')[3]
        const value = this.forms.get(token)
        if (
            !value ||
            value.expiresAt <= Date.now() ||
            value.userId !== interaction.user.id ||
            value.channelId !== interaction.channelId
        )
            throw new ShootInputError(uiText('shoot.expired'))
        return modal(value.shoot, value.edit)
    }

    async command(interaction) {
        await this.operation('defer_reply', () => interaction.deferReply({ flags: MessageFlags.Ephemeral }))
        const action = interaction.options.getSubcommand()
        if (action === 'setup') {
            const invited = parseMembers(interaction.options.getString('members') || '')
            const id = crypto.randomUUID()
            this.failures.update({ shootId: id })
            await this.store.createShootDraft(id, interaction.guildId, interaction.user.id, invited)
            await this.prepareForm(interaction, await this.store.getShoot(id, interaction.guildId))
            return
        }
        const shoot = await this.store.shootForChannel(interaction.guildId, interaction.channelId)
        if (!shoot) throw new ShootInputError(uiText('shoot.notShoot'))
        this.failures.update({ shootId: shoot.id, name: shoot.name, status: shoot.status })
        if (action === 'edit') {
            if (!['open', 'closed'].includes(shoot.status)) throw new ShootInputError(uiText('shoot.pending'))
            await this.prepareForm(interaction, shoot, true)
            return
        }
        await this.withLock(shoot.id, async () => {
            const members = this.membersForPass(interaction.guild)
            const current = await this.cleanupAnnouncement(await this.store.getShoot(shoot.id, interaction.guildId))
            if (action === 'crew') {
                const rows = await this.store.shootParticipants(shoot.id)
                const invited =
                    rows
                        .filter((row) => row.invited)
                        .map((row) => `<@${row.user_id}>`)
                        .join(' ') || uiText('shoot.crewEmpty')
                const reacted =
                    rows
                        .filter((row) => row.reacted && !row.invited)
                        .map((row) => `<@${row.user_id}>`)
                        .join(' ') || uiText('shoot.crewEmpty')
                const embed = new EmbedBuilder()
                    .setTitle(uiText('shoot.crewHeading', { name: current.name }))
                    .addFields(
                        ...memberFields(uiText('shoot.crewInvited'), invited),
                        ...memberFields(uiText('shoot.crewReaction'), reacted)
                    )
                await interaction.editReply({ embeds: [embed], allowedMentions: noMentions })
                return
            }
            if (action === 'add') {
                if (current.status !== 'open') throw new ShootInputError(uiText('shoot.addOpenOnly'))
                const user = interaction.options.getUser('user', true)
                if (!(await this.eligible(interaction.guild, user.id, members)))
                    throw new ShootInputError(uiText('shoot.ineligible', { userId: user.id }))
                const participants = await this.participantIds(current, interaction.guild, members)
                if (!participants.includes(user.id) && participants.length >= 98)
                    throw new ShootInputError(uiText('shoot.full'))
                await this.operation('save_participant', () => this.store.inviteShootParticipant(shoot.id, user.id))
                this.failures.update({ persisted: true })
                await this.synchronize(shoot.id, { members })
                this.failures.update({ synchronized: true, operation: 'send_confirmation' })
                await interaction.editReply({
                    content: uiText('shoot.added', { userId: user.id }),
                    allowedMentions: noMentions
                })
                return
            }
            if (action === 'remove') {
                if (!['open', 'closed'].includes(current.status)) throw new ShootInputError(uiText('shoot.pending'))
                const user = interaction.options.getUser('user', true)
                if (user.id === current.organizer_id) throw new ShootInputError(uiText('shoot.removeOrganizer'))
                const member = await members(user.id)
                if (current.announcement_id && current.announcement_deleted_at == null) {
                    const channel = await interaction.guild.channels.fetch(this.settings.announcementChannelId)
                    const message = await this.fetchMessage(channel, current.announcement_id)
                    // Remove the live reaction first: a stale reaction must not
                    // immediately restore membership during reconciliation.
                    await this.operation('remove_reaction', () =>
                        message?.reactions.cache
                            .get(EMOJI)
                            ?.users.remove(user.id)
                            .catch((error) => {
                                if (error.code !== 10008 && error.code !== 10014) throw error
                            })
                    )
                }
                await this.operation('remove_participant', () => this.store.removeShootParticipant(shoot.id, user.id))
                this.failures.update({ persisted: true })
                await this.synchronize(shoot.id, { members })
                this.failures.update({ synchronized: true, operation: 'send_confirmation' })
                await interaction.editReply({
                    content:
                        uiText('shoot.removed', { userId: user.id }) +
                        (this.hasProductionAccess(member) ? ` ${uiText('shoot.removedAdminAccess')}` : ''),
                    allowedMentions: noMentions
                })
                return
            }
            if (action === 'close' || action === 'reopen') {
                if (!['open', 'closed'].includes(current.status)) throw new ShootInputError(uiText('shoot.pending'))
                // Honor the current admission policy before changing it, including
                // reactions added during an outage while the shoot was closed.
                await this.reconcileReactions(current, members)
                await this.operation('save_shoot_status', () =>
                    this.store.updateShoot(shoot.id, {
                        status: action === 'close' ? 'closing' : 'reopening',
                        closed_at: action === 'close' ? (current.closed_at ?? Date.now()) : null
                    })
                )
                this.failures.update({ persisted: true })
                const result = await this.synchronize(shoot.id, { republishAnnouncement: action === 'reopen', members })
                this.failures.update({ synchronized: true, operation: 'send_confirmation' })
                await interaction.editReply({
                    content:
                        action === 'close'
                            ? uiText('shoot.closedReply')
                            : uiText('shoot.reopenedReply', { channelId: result.channel_id }),
                    allowedMentions: noMentions
                })
            }
        })
    }

    async submitModal(interaction) {
        await this.operation('defer_reply', () => interaction.deferReply({ flags: MessageFlags.Ephemeral }))
        const [, , action, id, revision] = interaction.customId.split(':')
        const details = parseDetails(interaction.fields)
        await this.withLock(id, async () => {
            const members = this.membersForPass(interaction.guild)
            const shoot = await this.store.getShoot(id, interaction.guildId)
            if (!shoot) throw new ShootInputError(uiText('shoot.expired'))
            this.failures.update({
                shootId: id,
                name: shoot.name,
                status: shoot.status,
                channelId: shoot.channel_id || interaction.channelId
            })
            if (action === 'setup') {
                if (
                    shoot.status !== 'draft' ||
                    shoot.organizer_id !== interaction.user.id ||
                    Date.now() - shoot.created_at >= 30 * 60000
                ) {
                    throw new ShootInputError(uiText('shoot.expired'))
                }
                for (const row of await this.store.shootParticipants(id)) {
                    if (!(await this.eligible(interaction.guild, row.user_id, members))) {
                        throw new ShootInputError(uiText('shoot.ineligible', { userId: row.user_id }))
                    }
                }
                await this.operation('save_shoot_details', () =>
                    this.store.updateShoot(id, { ...details, status: 'provisioning' })
                )
            } else if (action === 'edit') {
                if (
                    !['open', 'closed'].includes(shoot.status) ||
                    String(shoot.revision) !== revision ||
                    shoot.channel_id !== interaction.channelId
                ) {
                    throw new ShootInputError(uiText('shoot.expired'))
                }
                await this.operation('save_shoot_details', () => this.store.updateShoot(id, details))
            } else throw new ShootInputError(uiText('shoot.expired'))
            this.failures.update({ persisted: true })
            const result = await this.synchronize(id, { republishAnnouncement: action === 'edit', members })
            this.failures.update({ synchronized: true, operation: 'send_confirmation' })
            await interaction.editReply({
                content:
                    action === 'setup'
                        ? uiText('shoot.created', { channelId: result.channel_id })
                        : uiText('shoot.updated'),
                allowedMentions: noMentions
            })
        })
    }

    fetchMessage(...args) {
        return this.resources.fetchMessage(...args)
    }

    // Durable markers recover a successful Discord send whose response/DB write was lost.
    // Scan all pages; Discord's enforceNonce alone only deduplicates recent sends.
    recoverMessage(...args) {
        return this.resources.recoverMessage(...args)
    }

    ensureMessage(...args) {
        return this.resources.ensureMessage(...args)
    }

    async participantIds(shoot, guild, members = this.membersForPass(guild)) {
        const ids = [shoot.organizer_id]
        for (const row of await this.store.shootParticipants(shoot.id)) {
            if (row.user_id === shoot.organizer_id || (!row.invited && !row.reacted)) continue
            if (await this.eligible(guild, row.user_id, members)) ids.push(row.user_id)
        }
        if (ids.length > 98) throw new ShootInputError(uiText('shoot.full'), 'TVM_SHOOT_FULL')
        return ids
    }

    async synchronize(id, { republishAnnouncement = false, members } = {}) {
        let shoot = await this.operation('load_shoot', () => this.store.getShoot(id, this.config.guildId))
        this.failures.update({ shootId: id, name: shoot.name, status: shoot.status, channelId: shoot.channel_id })
        shoot = await this.cleanupAnnouncement(shoot)
        if (!ACTIVE_STATUSES.includes(shoot.status))
            throw Object.assign(new Error(uiText('shoot.missingChannel')), { code: 'TVM_SHOOT_CHANNEL_MISSING' })
        const guild = await this.operation('fetch_guild', () => this.client.guilds.fetch(this.config.guildId))
        members ||= this.membersForPass(guild)
        const closed = ['closing', 'closed'].includes(shoot.status)
        const participantIds = await this.participantIds(shoot, guild, members)
        // Member overwrites take precedence over role overwrites. Preserve archive
        // posting for production-access holders and participating admins.
        const writableParticipantIds = new Set()
        if (closed) {
            for (const userId of participantIds) {
                const member = await members(userId)
                if (isBotAdmin(member, this.config.adminRoleId) || this.hasProductionAccess(member)) {
                    writableParticipantIds.add(userId)
                }
            }
        }
        const permissions = overwrites(
            guild.id,
            this.client.user.id,
            participantIds,
            closed,
            this.config.productionAccessRoleId,
            writableParticipantIds
        )
        const resource = await this.operation('ensure_shoot_channel', () =>
            this.resources.ensureChannel(shoot, guild, permissions)
        )
        const channel = resource.channel
        shoot = resource.shoot
        const parent = closed ? this.settings.archiveCategoryId : this.settings.categoryId
        if (
            channel.parentId !== parent ||
            overwriteKey([...channel.permissionOverwrites.cache.values()]) !== overwriteKey(permissions)
        ) {
            await this.operation('update_permissions', () =>
                channel.edit({
                    parent,
                    lockPermissions: false,
                    permissionOverwrites: permissions,
                    reason: uiText('shoot.reason')
                })
            )
        }
        await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed, false, members)
        const announcementChannel = await this.operation('fetch_announcement_channel', () =>
            guild.channels.fetch(this.settings.announcementChannelId)
        )
        const announcement = await this.ensureMessage(
            announcementChannel,
            shoot,
            'invitation',
            'announcement_id',
            closed,
            republishAnnouncement
        )
        const beforeAnnouncement = shoot
        shoot = await this.store.getShoot(id, guild.id)
        if (beforeAnnouncement.announcement_deleted_at !== shoot.announcement_deleted_at) {
            await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed, false, members)
        }
        if (announcement && shoot.join_started_at == null) {
            // Use the actual publication time even when recovering a lost send response.
            await this.store.updateShoot(id, { join_started_at: announcement.createdTimestamp ?? shoot.created_at })
            shoot = await this.store.getShoot(id, guild.id)
            await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed, false, members)
            await this.ensureMessage(announcementChannel, shoot, 'invitation', 'announcement_id', closed)
        }
        if (announcement && !closed && !announcement.reactions.cache.get(EMOJI)?.me)
            await this.operation('add_join_reaction', () => announcement.react(EMOJI))
        if (['provisioning', 'closing', 'reopening'].includes(shoot.status)) {
            await this.store.updateShoot(id, { status: closed ? 'closed' : 'open' })
        }
        const result = await this.operation('load_shoot', () => this.store.getShoot(id, guild.id))
        this.failures.update({ status: result.status, channelId: result.channel_id })
        return result
    }

    cleanupAnnouncement(...args) {
        return this.resources.cleanupAnnouncement(...args)
    }

    async reactionUsers(message) {
        const reaction = message.reactions.cache.get(EMOJI)
        const users = new Map()
        if (!reaction) return users
        for (const type of [0, 1]) {
            let after
            while (true) {
                const page = await this.operation('fetch_reactions', () =>
                    reaction.users.fetch({ limit: 100, after, type })
                )
                for (const [id, user] of page) if (!user.bot) users.set(id, user)
                if (page.size < 100) break
                after = page.last().id
            }
        }
        return users
    }

    async reconcileReactions(shoot, members) {
        if (!shoot.announcement_id || shoot.announcement_deleted_at != null || !ACTIVE_STATUSES.includes(shoot.status))
            return
        const guild = await this.operation('fetch_guild', () => this.client.guilds.fetch(this.config.guildId))
        members ||= this.membersForPass(guild)
        const channel = await this.operation('fetch_announcement_channel', () =>
            guild.channels.fetch(this.settings.announcementChannelId)
        )
        const message = await this.fetchMessage(channel, shoot.announcement_id, 'fetch_invitation')
        // Deleting an invitation preserves membership. Routine sync does not republish it.
        if (!message) {
            await this.store.updateShoot(shoot.id, { announcement_deleted_at: Date.now() })
            return
        }
        const users = await this.reactionUsers(message)
        const rows = await this.store.shootParticipants(shoot.id)
        const admitted = new Set(await this.participantIds(shoot, guild, members))
        const rowsById = new Map(rows.map((row) => [row.user_id, row]))
        for (const row of rows) {
            if (row.reacted && row.reaction_message_id === shoot.announcement_id && !users.has(row.user_id)) {
                await this.store.setShootReaction(shoot.id, row.user_id, false, shoot.announcement_id)
                if (!row.invited && row.user_id !== shoot.organizer_id) admitted.delete(row.user_id)
            }
        }
        const accepts = joiningAllowed(shoot)
        let cleanupFailed = false
        for (const [userId, user] of users) {
            const row = rowsById.get(userId)
            const existing = admitted.has(userId)
            if (
                (!accepts && !existing) ||
                !(await this.eligible(guild, userId, members)) ||
                (!existing && admitted.size >= 98)
            ) {
                if (row?.reacted) {
                    await this.store.setShootReaction(shoot.id, userId, false, shoot.announcement_id)
                    if (userId !== shoot.organizer_id) admitted.delete(userId)
                }
                // Reaction cleanup is cosmetic. A failure here must not prevent
                // permission synchronization from revoking an ineligible member.
                try {
                    await this.operation('remove_reaction', () =>
                        message.reactions.cache.get(EMOJI).users.remove(userId)
                    )
                } catch (error) {
                    cleanupFailed = true
                    await this.report(shoot.id, error, { workflow: 'reaction_cleanup', retrying: true })
                    continue
                }
                // Notifications are best-effort; closed DMs must not prevent synchronization.
                await user.send({ content: uiText('shoot.joinDenied'), allowedMentions: noMentions }).catch(() => {})
                continue
            }
            if (!row?.reacted || row.reaction_message_id !== shoot.announcement_id) {
                await this.store.setShootReaction(shoot.id, userId, true, shoot.announcement_id)
                admitted.add(userId)
            }
        }
        if (!cleanupFailed) await this.failures.recovered({ shootId: shoot.id, workflow: 'reaction_cleanup' })
    }

    reconcileShoot(shoot, { trigger, republishAnnouncement = false }) {
        return this.failures.run(
            {
                shootId: shoot.id,
                name: shoot.name,
                status: shoot.status,
                channelId: shoot.channel_id,
                workflow: 'sync',
                trigger,
                retrying: true
            },
            async () => {
                const current = await this.operation('load_shoot', () =>
                    this.store.getShoot(shoot.id, this.config.guildId)
                )
                if (!current) return
                this.failures.update({ name: current.name, status: current.status, channelId: current.channel_id })
                const cleaned = await this.cleanupAnnouncement(current)
                if (!ACTIVE_STATUSES.includes(cleaned.status)) return
                const guild = await this.operation('fetch_guild', () => this.client.guilds.fetch(this.config.guildId))
                const members = this.membersForPass(guild)
                await this.reconcileReactions(cleaned, members)
                await this.synchronize(shoot.id, { republishAnnouncement, members })
                await this.failures.recovered({ shootId: shoot.id, workflow: 'sync' })
            }
        )
    }

    scheduleReaction(id) {
        const existing = this.reactionJobs.get(id)
        if (existing) {
            if (existing.running) existing.dirty = true
            return existing.promise
        }
        let resolve, reject
        const job = {
            running: false,
            dirty: false,
            promise: new Promise((done, fail) => {
                resolve = done
                reject = fail
            })
        }
        job.run = () => {
            if (job.running) return
            job.running = true
            this.withLock(id, async () => {
                do {
                    job.dirty = false
                    await this.reconcileShoot({ id }, { trigger: 'reaction' })
                } while (job.dirty)
            })
                .then(resolve, reject)
                .finally(() => this.reactionJobs.delete(id))
        }
        this.reactionJobs.set(id, job)
        if (this.stopped) job.run()
        else job.timer = setTimeout(job.run, 250)
        return job.promise
    }

    async onReaction(reaction, user) {
        if (
            this.stopped ||
            !this.settings ||
            user?.bot ||
            reaction.message.guildId !== this.config.guildId ||
            reaction.message.channelId !== this.settings.announcementChannelId ||
            reaction.emoji.id ||
            reaction.emoji.name !== EMOJI
        )
            return
        let shoot
        try {
            shoot = await this.store.shootForAnnouncement(this.config.guildId, reaction.message.id)
            if (!shoot || !ACTIVE_STATUSES.includes(shoot.status)) return
            await this.scheduleReaction(shoot.id)
        } catch (error) {
            await this.report(shoot?.id || reaction.message.id, error)
        }
    }

    async onReactionClear(message, emoji = null) {
        if (emoji && (emoji.id || emoji.name !== EMOJI)) return
        if (
            !this.settings ||
            message.guildId !== this.config.guildId ||
            message.channelId !== this.settings.announcementChannelId
        )
            return
        // Bulk removal has no user event; use the same REST reconciliation.
        await this.onReaction({ message, emoji: { id: null, name: EMOJI } }, { bot: false })
    }

    reconcileAll({ republishAnnouncements = false } = {}) {
        if (this.stopped || !this.settings) return Promise.resolve()
        this.republishRequested ||= republishAnnouncements
        if (this.running) {
            this.reconcileRequested = true
            return this.reconciliation
        }
        this.reconciliation = this.failures
            .run({ shootId: 'reconcile', workflow: 'reconcile', trigger: 'scheduled', retrying: true }, () =>
                this._reconcileAll()
            )
            .catch(async (error) => {
                await this.report('reconcile', error)
                throw error
            })
        return this.reconciliation
    }

    async _reconcileAll() {
        this.running = true
        try {
            do {
                this.reconcileRequested = false
                const republishAnnouncements = this.republishRequested
                this.republishRequested = false
                let failed = 0
                for (const shoot of await this.operation('list_shoots', () =>
                    this.store.allShoots(this.config.guildId)
                )) {
                    if (this.stopped) break
                    if (!ACTIVE_STATUSES.includes(shoot.status) && shoot.closed_at == null) continue
                    try {
                        await this.withLock(shoot.id, () =>
                            this.reconcileShoot(shoot, {
                                trigger: 'scheduled',
                                republishAnnouncement: republishAnnouncements
                            })
                        )
                    } catch (error) {
                        failed++
                        await this.report(shoot.id, error)
                    }
                }
                if (!this.stopped && !failed) this.lastSuccessAt = Date.now()
                await this.failures.recovered({ shootId: 'reconcile', workflow: 'reconcile' })
            } while (this.reconcileRequested && !this.stopped)
        } finally {
            this.running = false
        }
    }
}

module.exports = {
    ShootService,
    shootCommand,
    parseMembers,
    parseDetails,
    overwrites,
    joinDeadline,
    joiningAllowed,
    BOT_PERMISSIONS,
    ANNOUNCEMENT_PERMISSIONS,
    partials: [Partials.Message, Partials.Reaction, Partials.User]
}
