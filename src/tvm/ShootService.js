// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const crypto = require('node:crypto')
const { DateTime } = require('luxon')
const {
    ChannelType, PermissionFlagsBits: P, PermissionsBitField, Partials,
    SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    LabelBuilder, StringSelectMenuBuilder, EmbedBuilder, MessageFlags, escapeMarkdown
} = require('discord.js')
const { uiText } = require('./uiText')
const { hasAdminTeamRole, isBotAdmin, canManageBot } = require('./permissions')

const EMOJI = '🎬'
const ZONE = 'America/Toronto'
const FORMAT = 'yyyy-MM-dd HH:mm'
const JOIN_PERIODS = { day: 1, two_days: 2, week: 7, month: 30, never: null }
const PERIOD_TEXT = { day: 'shoot.joinDay', two_days: 'shoot.joinTwoDays', week: 'shoot.joinWeek',
    month: 'shoot.joinMonth', never: 'shoot.joinNever' }
const READ = [P.ViewChannel, P.ReadMessageHistory]
const WRITE = [P.SendMessages, P.SendMessagesInThreads, P.AddReactions]
const THREADS = [P.CreatePublicThreads, P.CreatePrivateThreads]
const BOT_PERMISSIONS = [...READ, ...WRITE, P.EmbedLinks, P.AttachFiles, P.ManageChannels, P.ManageRoles, P.PinMessages]
const ANNOUNCEMENT_PERMISSIONS = [...READ, P.SendMessages, P.EmbedLinks, P.AddReactions, P.ManageMessages]
const ACTIVE_STATUSES = ['provisioning', 'open', 'closing', 'closed', 'reopening']
const noMentions = { parse: [] }

function parseMembers(value = '') {
    const ids = [...value.matchAll(/<@!?(\d{17,20})>/g)].map(match => match[1])
    if (value.replace(/<@!?\d{17,20}>/g, '').replace(/[\s,]/g, '') || new Set(ids).size > 70) {
        throw new Error(uiText('shoot.mentions'))
    }
    return [...new Set(ids)]
}

function parseDetails(fields) {
    let name, location, date, clock, periods
    try {
        name = fields.getTextInputValue('name').trim()
        location = fields.getTextInputValue('location').trim()
        date = fields.getTextInputValue('date').trim()
        clock = fields.getTextInputValue('time').trim() || '12:00'
        periods = fields.getStringSelectValues('join_period')
    } catch {
        // Forms opened before a deployment may still use the previous input layout.
        throw new Error(uiText('shoot.expired'))
    }
    if (periods.length !== 1 || !Object.hasOwn(JOIN_PERIODS, periods[0])) throw new Error(uiText('shoot.invalidJoinPeriod'))
    const join_period = periods[0]
    if (!name || name.length > 100 || !location || location.length > 200) throw new Error(uiText('shoot.invalidDetails'))
    if (!date) return { name, location, call_time: null, join_period }
    const value = `${date} ${clock}`
    const time = DateTime.fromFormat(value, FORMAT, { zone: ZONE, locale: 'en' })
    // Luxon normalizes DST gaps forward: round-trip to reject that normalization.
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) || !time.isValid || time.toFormat(FORMAT) !== value ||
        time.getPossibleOffsets().length !== 1) throw new Error(uiText('shoot.invalidTime'))
    return { name, location, call_time: time.toMillis(), join_period }
}

function joinDeadline(shoot) {
    const days = JOIN_PERIODS[shoot.join_period]
    return days == null || shoot.join_started_at == null ? null : shoot.join_started_at + days * 86400000
}

function joiningAllowed(shoot, now = Date.now()) {
    const deadline = joinDeadline(shoot)
    return shoot.announcement_deleted_at == null && ['open', 'reopening'].includes(shoot.status) &&
        (deadline == null || now < deadline)
}

function shootCommand() {
    return new SlashCommandBuilder().setName('shoot').setDescription(uiText('shoot.command'))
        // Authorization is checked for every command and modal. Administrator-only
        // defaults would hide the command from members with the Admin Team role.
        .setDefaultMemberPermissions(null)
        .addSubcommand(s => s.setName('setup').setDescription(uiText('shoot.setup'))
            .addStringOption(o => o.setName('members').setDescription(uiText('shoot.membersOption')).setMaxLength(1700)))
        .addSubcommand(s => s.setName('edit').setDescription(uiText('shoot.edit')))
        .addSubcommand(s => s.setName('crew').setDescription(uiText('shoot.crew')))
        .addSubcommand(s => s.setName('add').setDescription(uiText('shoot.add'))
            .addUserOption(o => o.setName('user').setDescription(uiText('shoot.addUserOption')).setRequired(true)))
        .addSubcommand(s => s.setName('close').setDescription(uiText('shoot.close')))
        .addSubcommand(s => s.setName('reopen').setDescription(uiText('shoot.reopen'))).toJSON()
}

function modal(shoot, edit = false) {
    const id = `tvm:shoot:${edit ? 'edit' : 'setup'}:${shoot.id}${edit ? `:${shoot.revision}` : ''}`
    const inputs = [
        ['name', uiText('shoot.nameLabel'), 100, shoot.name, true],
        ['date', uiText('shoot.dateLabel'), 10, shoot.call_time != null ? DateTime.fromMillis(shoot.call_time, { zone: ZONE }).toFormat('yyyy-MM-dd') : '', false],
        ['time', uiText('shoot.timeLabel'), 5, shoot.call_time != null ? DateTime.fromMillis(shoot.call_time, { zone: ZONE }).toFormat('HH:mm') : '', false],
        ['location', uiText('shoot.locationLabel'), 200, shoot.location, true]
    ]
    const select = new StringSelectMenuBuilder().setCustomId('join_period').setMinValues(1).setMaxValues(1).setRequired(true)
        .addOptions(Object.keys(JOIN_PERIODS).map(value => ({ label: uiText(PERIOD_TEXT[value]), value,
            default: value === shoot.join_period })))
    return new ModalBuilder().setCustomId(id).setTitle(edit ? uiText('shoot.editTitle') : uiText('shoot.setupTitle'))
        .addLabelComponents(...inputs.map(([id, label, max, value, required]) => {
            const input = new TextInputBuilder().setCustomId(id)
                .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max)
            if (value) input.setValue(value)
            return new LabelBuilder().setLabel(label).setTextInputComponent(input)
        }), new LabelBuilder().setLabel(uiText('shoot.joinLabel')).setDescription(uiText('shoot.joinDescription'))
            .setStringSelectMenuComponent(select))
}

function overwrites(guildId, botId, participantIds, closed, adminRoleId, adminParticipantIds = new Set()) {
    const everyoneDeny = [...WRITE, ...THREADS, P.ViewChannel]
    return [
        { id: guildId, type: 0, allow: [], deny: everyoneDeny },
        { id: botId, type: 1, allow: BOT_PERMISSIONS, deny: [] },
        ...(adminRoleId ? [{ id: adminRoleId, type: 0, allow: [...READ, ...WRITE, P.AttachFiles, P.EmbedLinks, P.UseApplicationCommands], deny: THREADS }] : []),
        ...[...new Set(participantIds)].filter(id => id !== botId).map(id => ({
            id, type: 1, allow: closed && !adminParticipantIds.has(id) ? READ : [...READ, ...WRITE, P.AttachFiles, P.EmbedLinks],
            deny: closed && !adminParticipantIds.has(id) ? [...WRITE, ...THREADS] : THREADS
        }))
    ]
}

function overwriteKey(entries) {
    return JSON.stringify(entries.map(entry => [entry.id, entry.type,
        String(PermissionsBitField.resolve(entry.allow)), String(PermissionsBitField.resolve(entry.deny))])
        .sort((a, b) => a[0].localeCompare(b[0])))
}

function embedKey(embed) {
    if (!embed) return null
    const data = embed.toJSON()
    // Discord adds fields such as type: rich and inline: false to REST responses.
    // Compare the rendered values so unchanged briefs do not get edited every minute.
    return JSON.stringify([data.title, data.description, data.color, data.footer?.text,
        data.fields?.map(field => [field.name, field.value, Boolean(field.inline)])])
}

class ShootService {
    constructor({ client, store, config, alertAdmins }) {
        this.client = client
        this.store = store
        this.config = config
        this.settings = config.shoots
        this.alertAdmins = alertAdmins
        this.locks = new Map()
        this.running = false
    }

    withLock(id, work) {
        const previous = this.locks.get(id) || Promise.resolve()
        const next = previous.catch(() => {}).then(work)
        this.locks.set(id, next)
        return next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id) })
    }

    async report(id, error) {
        console.error(`[TVM Shoot ${id}]`, error?.message || error)
        await this.alertAdmins(uiText('shoot.alert', { shootId: id, error: String(error?.message || error).slice(0, 700) }))
    }

    async initialize() {
        if (!this.settings) return
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const bot = await guild.members.fetchMe()
        for (const [id, type, permissions] of [
            [this.settings.announcementChannelId, ChannelType.GuildText, ANNOUNCEMENT_PERMISSIONS],
            [this.settings.categoryId, ChannelType.GuildCategory, BOT_PERMISSIONS],
            [this.settings.archiveCategoryId, ChannelType.GuildCategory, BOT_PERMISSIONS]
        ]) {
            const channel = await guild.channels.fetch(id)
            if (!channel || channel.guildId !== guild.id || channel.type !== type || !channel.permissionsFor(bot)?.has(permissions)) {
                throw new Error(uiText('shoot.configError'))
            }
        }
        await this.reconcileAll({ republishAnnouncements: true })
        this.timer = setInterval(() => this.reconcileAll().catch(error => this.report('reconcile', error)), 60000)
        this.timer.unref()
    }

    stop() { clearInterval(this.timer) }

    async eligible(guild, userId) {
        const member = await guild.members.fetch({ user: userId, force: true }).catch(error => {
            if (error.code === 10007) return null
            throw error
        })
        return Boolean(member && !member.user.bot &&
            (isBotAdmin(member, this.config.adminRoleId) ||
                await this.store.isAuthorizedUser(guild.id, userId)))
    }

    async handleInteraction(interaction) {
        const isCommand = interaction.isChatInputCommand() && interaction.commandName === 'shoot'
        const isModal = interaction.isModalSubmit() && interaction.customId.startsWith('tvm:shoot:')
        if (!isCommand && !isModal) return false
        if (interaction.guildId !== this.config.guildId) return true
        try {
            // Do not trust command defaults or a previously authorized form.
            if (!canManageBot(interaction, this.config.adminRoleId)) {
                await interaction.reply({ content: uiText('shoot.permission'), flags: MessageFlags.Ephemeral })
                return true
            }
            if (!this.settings) throw new Error(uiText('shoot.disabled'))
            if (interaction.channel?.type !== ChannelType.GuildText) throw new Error(uiText('shoot.notText'))
            if (isModal) await this.submitModal(interaction)
            else await this.command(interaction)
        } catch (error) {
            await this.report(isModal ? interaction.customId.split(':')[3] : interaction.channelId, error)
            const payload = { content: uiText('admin.operationFailed', { error: String(error?.message || error).slice(0, 1500) }),
                components: [], allowedMentions: noMentions }
            if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {})
            else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {})
        }
        return true
    }

    async command(interaction) {
        const action = interaction.options.getSubcommand()
        if (action === 'setup') {
            const invited = parseMembers(interaction.options.getString('members') || '')
            const id = crypto.randomUUID()
            await this.store.createShootDraft(id, interaction.guildId, interaction.user.id, invited)
            await interaction.showModal(modal(await this.store.getShoot(id, interaction.guildId)))
            return
        }
        const shoot = await this.store.shootForChannel(interaction.guildId, interaction.channelId)
        if (!shoot) throw new Error(uiText('shoot.notShoot'))
        if (action === 'edit') {
            if (!['open', 'closed'].includes(shoot.status)) throw new Error(uiText('shoot.pending'))
            await interaction.showModal(modal(shoot, true))
            return
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        await this.withLock(shoot.id, async () => {
            const current = await this.cleanupAnnouncement(await this.store.getShoot(shoot.id, interaction.guildId))
            if (action === 'crew') {
                const rows = await this.store.shootParticipants(shoot.id)
                const invited = rows.filter(row => row.invited).map(row => `<@${row.user_id}>`).join(' ') || uiText('shoot.crewEmpty')
                const reacted = rows.filter(row => row.reacted && !row.invited).map(row => `<@${row.user_id}>`).join(' ') || uiText('shoot.crewEmpty')
                const embed = new EmbedBuilder().setTitle(uiText('shoot.crewHeading', { name: current.name }))
                    .addFields(...this.memberFields(uiText('shoot.crewInvited'), invited),
                        ...this.memberFields(uiText('shoot.crewReaction'), reacted))
                await interaction.editReply({ embeds: [embed], allowedMentions: noMentions })
                return
            }
            if (action === 'add') {
                if (current.status !== 'open') throw new Error(uiText('shoot.addOpenOnly'))
                const user = interaction.options.getUser('user', true)
                if (!await this.eligible(interaction.guild, user.id)) throw new Error(uiText('shoot.ineligible', { userId: user.id }))
                const participants = await this.participantIds(current, interaction.guild)
                if (!participants.includes(user.id) && participants.length >= 98) throw new Error(uiText('shoot.full'))
                await this.store.inviteShootParticipant(shoot.id, user.id)
                await this.synchronize(shoot.id)
                await interaction.editReply({ content: uiText('shoot.added', { userId: user.id }), allowedMentions: noMentions })
                return
            }
            if (action === 'close' || action === 'reopen') {
                if (!['open', 'closed'].includes(current.status)) throw new Error(uiText('shoot.pending'))
                // Honor the current admission policy before changing it, including
                // reactions added during an outage while the shoot was closed.
                await this.reconcileReactions(current)
                await this.store.updateShoot(shoot.id, { status: action === 'close' ? 'closing' : 'reopening',
                    closed_at: action === 'close' ? (current.closed_at ?? Date.now()) : null })
                const result = await this.synchronize(shoot.id, { republishAnnouncement: action === 'reopen' })
                await interaction.editReply({ content: action === 'close' ? uiText('shoot.closedReply') :
                    uiText('shoot.reopenedReply', { channelId: result.channel_id }), allowedMentions: noMentions })
            }
        })
    }

    memberFields(label, mentions) {
        const chunks = mentions.match(/.{1,1000}(?:\s|$)/g) || [mentions]
        return chunks.map(value => ({ name: label, value: value.trim() }))
    }

    async submitModal(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const [, , action, id, revision] = interaction.customId.split(':')
        const details = parseDetails(interaction.fields)
        await this.withLock(id, async () => {
            const shoot = await this.store.getShoot(id, interaction.guildId)
            if (!shoot) throw new Error(uiText('shoot.expired'))
            if (action === 'setup') {
                if (shoot.status !== 'draft' || shoot.organizer_id !== interaction.user.id || Date.now() - shoot.created_at > 30 * 60000) {
                    throw new Error(uiText('shoot.expired'))
                }
                for (const row of await this.store.shootParticipants(id)) {
                    if (!await this.eligible(interaction.guild, row.user_id)) {
                        throw new Error(uiText('shoot.ineligible', { userId: row.user_id }))
                    }
                }
                await this.store.updateShoot(id, { ...details, status: 'provisioning' })
            } else if (action === 'edit') {
                if (!['open', 'closed'].includes(shoot.status) || String(shoot.revision) !== revision || shoot.channel_id !== interaction.channelId) {
                    throw new Error(uiText('shoot.expired'))
                }
                await this.store.updateShoot(id, details)
            } else throw new Error(uiText('shoot.expired'))
            const result = await this.synchronize(id, { republishAnnouncement: action === 'edit' })
            await interaction.editReply({ content: action === 'setup' ? uiText('shoot.created', { channelId: result.channel_id }) :
                uiText('shoot.updated'), allowedMentions: noMentions })
        })
    }

    async fetchMessage(channel, id) {
        if (!id) return null
        return channel.messages.fetch({ message: id, force: true }).catch(error => {
            if (error.code === 10008) return null
            throw error
        })
    }

    // Durable markers recover a successful Discord send whose response/DB write was lost.
    // Scan all pages; Discord's enforceNonce alone only deduplicates recent sends.
    async recoverMessage(channel, shoot, kind) {
        const marker = uiText('shoot.marker', { shootId: shoot.id, kind })
        let before
        while (true) {
            const page = await channel.messages.fetch({ limit: 100, before })
            const found = [...page.values()].find(message => message.author.id === this.client.user.id &&
                message.embeds.some(embed => embed.footer?.text === marker))
            if (found) return found
            if (page.size < 100) return null
            before = page.last().id
        }
    }

    render(shoot, kind, closed) {
        const deadline = joinDeadline(shoot)
        const expired = deadline != null && Date.now() >= deadline
        const joinValue = shoot.announcement_deleted_at != null ? uiText('shoot.joinUnavailable') : deadline != null ? `<t:${Math.floor(deadline / 1000)}:F>` :
            (shoot.join_period === 'never' ? uiText('shoot.joinNever') :
                uiText('shoot.joinPending', { period: uiText(PERIOD_TEXT[shoot.join_period]) }))
        const embed = new EmbedBuilder().setTitle(escapeMarkdown(shoot.name)).setColor(closed ? 0x747f8d : 0x9b59b6)
            .setDescription(closed ? uiText('shoot.statusClosed') : uiText('shoot.statusOpen'))
            .addFields(
                { name: uiText('shoot.callField'), value: shoot.call_time == null ? uiText('shoot.unscheduled') :
                    `<t:${Math.floor(shoot.call_time / 1000)}:F>` },
                { name: uiText('shoot.locationField'), value: escapeMarkdown(shoot.location) },
                { name: uiText('shoot.organizerField'), value: `<@${shoot.organizer_id}>` },
                { name: uiText('shoot.chatField'), value: `<#${shoot.channel_id}>` },
                { name: uiText('shoot.joinField'), value: joinValue }
            ).setFooter({ text: uiText('shoot.marker', { shootId: shoot.id, kind }) })
        return { embeds: [embed], content: kind === 'invitation' ?
            (closed ? uiText('shoot.closedInvitation') : expired ? uiText('shoot.expiredInvitation') :
                uiText('shoot.invitation')) : '', allowedMentions: noMentions }
    }

    async ensureMessage(channel, shoot, kind, column, closed, republishAnnouncement = false) {
        const invitation = kind === 'invitation'
        const republish = republishAnnouncement || Boolean(shoot.announcement_republish_pending)
        // Cleanup remains final while a shoot is closed. Reopening may republish.
        if (invitation && closed && shoot.closed_at != null && Date.now() >= shoot.closed_at + 86400000) return null
        if (invitation && shoot.announcement_deleted_at != null && !republish) return null
        let message = await this.fetchMessage(channel, shoot[column])
        if (invitation && !message && (shoot[column] || closed) && !republish) {
            // Routine synchronization honors deletion. Important events may publish
            // again; persist that intent before sending so ambiguous failures retry.
            if (shoot.announcement_deleted_at == null) {
                await this.store.updateShoot(shoot.id, { announcement_deleted_at: Date.now() })
            }
            return null
        }
        if (invitation && !message && republish && !shoot.announcement_republish_pending) {
            await this.store.updateShoot(shoot.id, { announcement_republish_pending: 1 })
        }
        if (!message) message = await this.recoverMessage(channel, shoot, kind)
        const payload = this.render(invitation ? { ...shoot, announcement_deleted_at: null } : shoot, kind, closed)
        if (kind === 'brief') {
            const names = []
            const guild = await this.client.guilds.fetch(shoot.guild_id)
            for (const row of await this.store.shootParticipants(shoot.id)) {
                if (!row.invited || row.user_id === shoot.organizer_id) continue
                const member = await guild.members.fetch({ user: row.user_id, force: true }).catch(error => {
                    if (error.code === 10007) return null
                    throw error
                })
                const name = member?.displayName || member?.user.globalName || member?.user.username ||
                    uiText('shoot.formerMember', { userId: row.user_id })
                names.push(escapeMarkdown(name.replace(/<@/g, '＜@')).slice(0, 48))
            }
            payload.embeds[0].addFields(...this.memberFields(uiText('shoot.crewInvited'),
                names.join(', ') || uiText('shoot.crewEmpty')))
        }
        if (!message) {
            const nonce = crypto.createHash('sha256').update(`${shoot.id}:${kind}:${shoot[column] || ''}`).digest('hex').slice(0, 24)
            message = await channel.send({ ...payload, nonce, enforceNonce: true })
        } else {
            if (message.content !== payload.content || embedKey(message.embeds[0]) !== embedKey(payload.embeds[0])) {
                await message.edit(payload)
            }
        }
        const values = {}
        if (shoot[column] !== message.id) values[column] = message.id
        if (invitation && (shoot.announcement_deleted_at != null || republish)) {
            values.announcement_deleted_at = null
            values.announcement_republish_pending = 0
        }
        if (Object.keys(values).length) await this.store.updateShoot(shoot.id, values)
        if (kind === 'brief' && !message.pinned) await message.pin(uiText('shoot.reason'))
        return message
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
                const member = await guild.members.fetch({ user: userId, force: true }).catch(error => {
                    if (error.code === 10007) return null
                    throw error
                })
                if (hasAdminTeamRole(member, this.config.adminRoleId)) adminParticipantIds.add(userId)
            }
        }
        const permissions = overwrites(guild.id, this.client.user.id, participantIds, closed,
            this.config.adminRoleId, adminParticipantIds)
        let channel
        if (shoot.channel_id) {
            channel = await guild.channels.fetch(shoot.channel_id, { force: true }).catch(error => {
                if (error.code === 10003) return null
                throw error
            })
            if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
                await this.store.updateShoot(id, { status: 'missing' })
                throw new Error(uiText('shoot.missingChannel'))
            }
        } else {
            const topic = uiText('shoot.channelTopic', { shootId: shoot.id })
            const channels = await guild.channels.fetch()
            channel = [...channels.values()].find(candidate => candidate?.type === ChannelType.GuildText && candidate.topic === topic)
            if (!channel) {
                const slug = shoot.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'shoot'
                channel = await guild.channels.create({ name: `${slug}-${shoot.id.slice(0, 8)}`, type: ChannelType.GuildText,
                    parent: this.settings.categoryId, topic, permissionOverwrites: permissions, reason: uiText('shoot.reason') })
            }
            await this.store.updateShoot(id, { channel_id: channel.id })
            shoot = await this.store.getShoot(id, guild.id)
        }
        const parent = closed ? this.settings.archiveCategoryId : this.settings.categoryId
        if (channel.parentId !== parent || overwriteKey([...channel.permissionOverwrites.cache.values()]) !== overwriteKey(permissions)) {
            await channel.edit({ parent, lockPermissions: false, permissionOverwrites: permissions, reason: uiText('shoot.reason') })
        }
        await this.ensureMessage(channel, shoot, 'brief', 'brief_id', closed)
        const announcementChannel = await guild.channels.fetch(this.settings.announcementChannelId)
        const announcement = await this.ensureMessage(announcementChannel, shoot, 'invitation', 'announcement_id', closed, republishAnnouncement)
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

    async cleanupAnnouncement(shoot) {
        if ((shoot.announcement_deleted_at != null && !shoot.announcement_republish_pending) ||
            !['closing', 'closed', 'missing'].includes(shoot.status)) return shoot
        const guild = await this.client.guilds.fetch(shoot.guild_id)
        const channel = await guild.channels.fetch(this.settings.announcementChannelId)
        if (shoot.closed_at == null) {
            if (shoot.status === 'missing') return shoot
            // Older releases did not store close times. The existing closed message
            // gives the best available date; persist it once so retries cannot reset it.
            const message = await this.fetchMessage(channel, shoot.announcement_id)
            await this.store.updateShoot(shoot.id, { closed_at: message?.editedTimestamp ?? message?.createdTimestamp ?? Date.now() })
            shoot = await this.store.getShoot(shoot.id, shoot.guild_id)
        }
        if (Date.now() < shoot.closed_at + 86400000) return shoot
        const messageIds = new Set(shoot.announcement_id ? [shoot.announcement_id] : [])
        if (shoot.announcement_republish_pending) {
            const recovered = await this.recoverMessage(channel, shoot, 'invitation')
            if (recovered) messageIds.add(recovered.id)
        }
        for (const messageId of messageIds) {
            await channel.messages.delete(messageId).catch(error => {
                if (error.code !== 10008) throw error
            })
        }
        await this.store.updateShoot(shoot.id, { announcement_deleted_at: Date.now(), announcement_republish_pending: 0 })
        return this.store.getShoot(shoot.id, shoot.guild_id)
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
        if (!shoot.announcement_id || shoot.announcement_deleted_at != null || !ACTIVE_STATUSES.includes(shoot.status)) return
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
        let enrolled = rows.filter(row => row.invited || row.reacted).length
        const rowsById = new Map(rows.map(row => [row.user_id, row]))
        for (const row of rows) {
            if (row.reacted && row.reaction_message_id === shoot.announcement_id && !users.has(row.user_id)) {
                await this.store.setShootReaction(shoot.id, row.user_id, false, shoot.announcement_id)
                if (!row.invited) enrolled--
            }
        }
        const accepts = joiningAllowed(shoot)
        for (const [userId, user] of users) {
            const row = rowsById.get(userId)
            const existing = Boolean(row?.invited || row?.reacted)
            if ((!accepts && !existing) || !await this.eligible(guild, userId) || (!existing && enrolled >= 98)) {
                if (row?.reacted) {
                    await this.store.setShootReaction(shoot.id, userId, false, shoot.announcement_id)
                    if (!row.invited) enrolled--
                }
                // Reaction cleanup is cosmetic. A failure here must not prevent
                // permission synchronization from revoking an ineligible member.
                try { await message.reactions.cache.get(EMOJI).users.remove(userId) }
                catch (error) { await this.report(shoot.id, error); continue }
                // Notifications are best-effort; closed DMs must not prevent synchronization.
                await user.send({ content: uiText('shoot.joinDenied'), allowedMentions: noMentions }).catch(() => {})
                continue
            }
            if (!row?.reacted || row.reaction_message_id !== shoot.announcement_id) {
                await this.store.setShootReaction(shoot.id, userId, true, shoot.announcement_id)
                if (!existing) enrolled++
            }
        }
    }

    async onReaction(reaction, user) {
        if (!this.settings || user?.bot || reaction.message.guildId !== this.config.guildId ||
            reaction.message.channelId !== this.settings.announcementChannelId || reaction.emoji.id || reaction.emoji.name !== EMOJI) return
        let shoot
        try {
            shoot = await this.store.shootForAnnouncement(this.config.guildId, reaction.message.id)
            if (!shoot || !ACTIVE_STATUSES.includes(shoot.status)) return
            await this.withLock(shoot.id, async () => {
                const current = await this.store.getShoot(shoot.id, this.config.guildId)
                // Fetch REST state instead of trusting cached counts or out-of-order events.
                await this.reconcileReactions(current)
                await this.synchronize(current.id)
            })
        } catch (error) { await this.report(shoot?.id || reaction.message.id, error) }
    }

    async onReactionClear(message, emoji = null) {
        if (emoji && (emoji.id || emoji.name !== EMOJI)) return
        if (!this.settings || message.guildId !== this.config.guildId || message.channelId !== this.settings.announcementChannelId) return
        // Bulk removal has no user event; use the same REST reconciliation.
        await this.onReaction({ message, emoji: { id: null, name: EMOJI } }, { bot: false })
    }

    async reconcileAll({ republishAnnouncements = false } = {}) {
        if (!this.settings || this.running) return
        this.running = true
        try {
            for (const shoot of await this.store.allShoots(this.config.guildId)) {
                if (!ACTIVE_STATUSES.includes(shoot.status) && shoot.closed_at == null) continue
                try {
                    await this.withLock(shoot.id, async () => {
                        const current = await this.cleanupAnnouncement(await this.store.getShoot(shoot.id, this.config.guildId))
                        if (!ACTIVE_STATUSES.includes(current.status)) return
                        await this.reconcileReactions(current)
                        await this.synchronize(shoot.id, { republishAnnouncement: republishAnnouncements })
                    })
                } catch (error) { await this.report(shoot.id, error) }
            }
        } finally { this.running = false }
    }
}

module.exports = { ShootService, shootCommand, parseMembers, parseDetails, overwrites, joinDeadline, joiningAllowed,
    BOT_PERMISSIONS, ANNOUNCEMENT_PERMISSIONS, partials: [Partials.Message, Partials.Reaction, Partials.User] }
