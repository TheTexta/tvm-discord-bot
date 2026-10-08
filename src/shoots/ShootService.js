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
const { hasAdminTeamRole, isBotAdmin, canManageBot } = require('../shared/permissions')
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
    constructor({ client, store, config, alertAdmins }) {
        this.client = client
        this.store = store
        this.config = config
        this.settings = config.shoots
        this.alertAdmins = alertAdmins
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

    async report(id, error) {
        console.error(`[TVM Shoot ${id}]`, error?.message || error)
        await this.alertAdmins(
            uiText('shoot.alert', { shootId: id, error: String(error?.message || error).slice(0, 700) })
        )
    }

    async initialize() {
        if (!this.settings || this.stopped) return
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const bot = await guild.members.fetchMe()
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
        this.timer = setInterval(() => this.reconcileAll().catch((error) => this.report('reconcile', error)), 60000)
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

    async eligible(guild, userId) {
        const member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
            if (error.code === 10007) return null
            throw error
        })
        return Boolean(
            member &&
            !member.user.bot &&
            (isBotAdmin(member, this.config.adminRoleId) ||
                member.roles.cache.has(this.config.memberRoleId) ||
                member.roles.cache.has(this.config.execRoleId))
        )
    }

    async handleInteraction(interaction) {
        const isCommand = interaction.isChatInputCommand() && interaction.commandName === 'shoot'
        const isModal = interaction.isModalSubmit() && interaction.customId.startsWith('tvm:shoot:')
        const isForm = interaction.isButton?.() && interaction.customId.startsWith('tvm:shoot:form:')
        if (!isCommand && !isModal && !isForm) return false
        if (interaction.guildId !== this.config.guildId) return true
        try {
            // Do not trust command defaults or a previously authorized form.
            if (!canManageBot(interaction, this.config.adminRoleId)) {
                await interaction.reply({ content: uiText('shoot.permission'), flags: MessageFlags.Ephemeral })
                return true
            }
            if (!this.settings) throw new Error(uiText('shoot.disabled'))
            if (interaction.channel?.type !== ChannelType.GuildText) throw new Error(uiText('shoot.notText'))
            if (isForm) await interaction.showModal(this.openForm(interaction))
            else if (isModal) await this.submitModal(interaction)
            else await this.command(interaction)
        } catch (error) {
            await this.report(isModal ? interaction.customId.split(':')[3] : interaction.channelId, error)
            const payload = {
                content: uiText('admin.operationFailed', { error: String(error?.message || error).slice(0, 1500) }),
                components: [],
                allowedMentions: noMentions
            }
            if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {})
            else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {})
        }
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
            throw new Error(uiText('shoot.expired'))
        return modal(value.shoot, value.edit)
    }

    async command(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const action = interaction.options.getSubcommand()
        if (action === 'setup') {
            const invited = parseMembers(interaction.options.getString('members') || '')
            const id = crypto.randomUUID()
            await this.store.createShootDraft(id, interaction.guildId, interaction.user.id, invited)
            await this.prepareForm(interaction, await this.store.getShoot(id, interaction.guildId))
            return
        }
        const shoot = await this.store.shootForChannel(interaction.guildId, interaction.channelId)
        if (!shoot) throw new Error(uiText('shoot.notShoot'))
        if (action === 'edit') {
            if (!['open', 'closed'].includes(shoot.status)) throw new Error(uiText('shoot.pending'))
            await this.prepareForm(interaction, shoot, true)
            return
        }
        await this.withLock(shoot.id, async () => {
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
                if (current.status !== 'open') throw new Error(uiText('shoot.addOpenOnly'))
                const user = interaction.options.getUser('user', true)
                if (!(await this.eligible(interaction.guild, user.id)))
                    throw new Error(uiText('shoot.ineligible', { userId: user.id }))
                const participants = await this.participantIds(current, interaction.guild)
                if (!participants.includes(user.id) && participants.length >= 98) throw new Error(uiText('shoot.full'))
                await this.store.inviteShootParticipant(shoot.id, user.id)
                await this.synchronize(shoot.id)
                await interaction.editReply({
                    content: uiText('shoot.added', { userId: user.id }),
                    allowedMentions: noMentions
                })
                return
            }
            if (action === 'close' || action === 'reopen') {
                if (!['open', 'closed'].includes(current.status)) throw new Error(uiText('shoot.pending'))
                // Honor the current admission policy before changing it, including
                // reactions added during an outage while the shoot was closed.
                await this.reconcileReactions(current)
                await this.store.updateShoot(shoot.id, {
                    status: action === 'close' ? 'closing' : 'reopening',
                    closed_at: action === 'close' ? (current.closed_at ?? Date.now()) : null
                })
                const result = await this.synchronize(shoot.id, { republishAnnouncement: action === 'reopen' })
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const [, , action, id, revision] = interaction.customId.split(':')
        const details = parseDetails(interaction.fields)
        await this.withLock(id, async () => {
            const shoot = await this.store.getShoot(id, interaction.guildId)
            if (!shoot) throw new Error(uiText('shoot.expired'))
            if (action === 'setup') {
                if (
                    shoot.status !== 'draft' ||
                    shoot.organizer_id !== interaction.user.id ||
                    Date.now() - shoot.created_at >= 30 * 60000
                ) {
                    throw new Error(uiText('shoot.expired'))
                }
                for (const row of await this.store.shootParticipants(id)) {
                    if (!(await this.eligible(interaction.guild, row.user_id))) {
                        throw new Error(uiText('shoot.ineligible', { userId: row.user_id }))
                    }
                }
                await this.store.updateShoot(id, { ...details, status: 'provisioning' })
            } else if (action === 'edit') {
                if (
                    !['open', 'closed'].includes(shoot.status) ||
                    String(shoot.revision) !== revision ||
                    shoot.channel_id !== interaction.channelId
                ) {
                    throw new Error(uiText('shoot.expired'))
                }
                await this.store.updateShoot(id, details)
            } else throw new Error(uiText('shoot.expired'))
            const result = await this.synchronize(id, { republishAnnouncement: action === 'edit' })
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

    async participantIds(shoot, guild) {
        const ids = [shoot.organizer_id]
        for (const row of await this.store.shootParticipants(shoot.id)) {
            if (row.user_id === shoot.organizer_id || (!row.invited && !row.reacted)) continue
            if (await this.eligible(guild, row.user_id)) ids.push(row.user_id)
        }
        if (ids.length > 98) throw new Error(uiText('shoot.full'))
        return ids
    }

    async synchronize(id, { republishAnnouncement = false } = {}) {
        let shoot = await this.store.getShoot(id, this.config.guildId)
        shoot = await this.cleanupAnnouncement(shoot)
        if (!ACTIVE_STATUSES.includes(shoot.status)) throw new Error(uiText('shoot.missingChannel'))
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const closed = ['closing', 'closed'].includes(shoot.status)
        const participantIds = await this.participantIds(shoot, guild)
        // Member overwrites take precedence over role overwrites. Keep Admin Team
        // participants able to run management commands in archived chats too.
        const adminParticipantIds = new Set()
        if (closed) {
            for (const userId of participantIds) {
                const member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
                    if (error.code === 10007) return null
                    throw error
                })
                if (hasAdminTeamRole(member, this.config.adminRoleId)) adminParticipantIds.add(userId)
            }
        }
        const permissions = overwrites(
            guild.id,
            this.client.user.id,
            participantIds,
            closed,
            this.config.adminRoleId,
            adminParticipantIds
        )
        const resource = await this.resources.ensureChannel(shoot, guild, permissions)
        const channel = resource.channel
        shoot = resource.shoot
        const parent = closed ? this.settings.archiveCategoryId : this.settings.categoryId
        if (
            channel.parentId !== parent ||
            overwriteKey([...channel.permissionOverwrites.cache.values()]) !== overwriteKey(permissions)
        ) {
            await channel.edit({
                parent,
                lockPermissions: false,
                permissionOverwrites: permissions,
                reason: uiText('shoot.reason')
            })
        }
        await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed)
        const announcementChannel = await guild.channels.fetch(this.settings.announcementChannelId)
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
            await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed)
        }
        if (announcement && shoot.join_started_at == null) {
            // Use the actual publication time even when recovering a lost send response.
            await this.store.updateShoot(id, { join_started_at: announcement.createdTimestamp ?? shoot.created_at })
            shoot = await this.store.getShoot(id, guild.id)
            await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed)
            await this.ensureMessage(announcementChannel, shoot, 'invitation', 'announcement_id', closed)
        }
        if (announcement && !closed && !announcement.reactions.cache.get(EMOJI)?.me) await announcement.react(EMOJI)
        if (['provisioning', 'closing', 'reopening'].includes(shoot.status)) {
            await this.store.updateShoot(id, { status: closed ? 'closed' : 'open' })
        }
        return this.store.getShoot(id, guild.id)
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
                const page = await reaction.users.fetch({ limit: 100, after, type })
                for (const [id, user] of page) if (!user.bot) users.set(id, user)
                if (page.size < 100) break
                after = page.last().id
            }
        }
        return users
    }

    async reconcileReactions(shoot) {
        if (!shoot.announcement_id || shoot.announcement_deleted_at != null || !ACTIVE_STATUSES.includes(shoot.status))
            return
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const channel = await guild.channels.fetch(this.settings.announcementChannelId)
        const message = await this.fetchMessage(channel, shoot.announcement_id)
        // Deleting an invitation preserves membership. Routine sync does not republish it.
        if (!message) {
            await this.store.updateShoot(shoot.id, { announcement_deleted_at: Date.now() })
            return
        }
        const users = await this.reactionUsers(message)
        const rows = await this.store.shootParticipants(shoot.id)
        const admitted = new Set(await this.participantIds(shoot, guild))
        const rowsById = new Map(rows.map((row) => [row.user_id, row]))
        for (const row of rows) {
            if (row.reacted && row.reaction_message_id === shoot.announcement_id && !users.has(row.user_id)) {
                await this.store.setShootReaction(shoot.id, row.user_id, false, shoot.announcement_id)
                if (!row.invited && row.user_id !== shoot.organizer_id) admitted.delete(row.user_id)
            }
        }
        const accepts = joiningAllowed(shoot)
        for (const [userId, user] of users) {
            const row = rowsById.get(userId)
            const existing = admitted.has(userId)
            if (
                (!accepts && !existing) ||
                !(await this.eligible(guild, userId)) ||
                (!existing && admitted.size >= 98)
            ) {
                if (row?.reacted) {
                    await this.store.setShootReaction(shoot.id, userId, false, shoot.announcement_id)
                    if (userId !== shoot.organizer_id) admitted.delete(userId)
                }
                // Reaction cleanup is cosmetic. A failure here must not prevent
                // permission synchronization from revoking an ineligible member.
                try {
                    await message.reactions.cache.get(EMOJI).users.remove(userId)
                } catch (error) {
                    await this.report(shoot.id, error)
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
                    const current = await this.store.getShoot(id, this.config.guildId)
                    if (!current || !ACTIVE_STATUSES.includes(current.status)) return
                    await this.reconcileReactions(current)
                    await this.synchronize(id)
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
        this.reconciliation = this._reconcileAll()
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
                for (const shoot of await this.store.allShoots(this.config.guildId)) {
                    if (this.stopped) break
                    if (!ACTIVE_STATUSES.includes(shoot.status) && shoot.closed_at == null) continue
                    try {
                        await this.withLock(shoot.id, async () => {
                            const current = await this.cleanupAnnouncement(
                                await this.store.getShoot(shoot.id, this.config.guildId)
                            )
                            if (!ACTIVE_STATUSES.includes(current.status)) return
                            await this.reconcileReactions(current)
                            await this.synchronize(shoot.id, { republishAnnouncement: republishAnnouncements })
                        })
                    } catch (error) {
                        failed++
                        await this.report(shoot.id, error)
                    }
                }
                if (!this.stopped && !failed) this.lastSuccessAt = Date.now()
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
