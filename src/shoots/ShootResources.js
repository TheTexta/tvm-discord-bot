// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const crypto = require('node:crypto')
const { escapeMarkdown, ChannelType } = require('discord.js')
const { uiText } = require('../shared/uiText')
const { shootMarker, shootTopic } = require('./identifiers')
const { embedKey } = require('./policy')
const { renderShoot, memberFields } = require('./render')

class ShootResources {
    constructor(service) {
        this.service = service
    }
    get client() {
        return this.service.client
    }
    get store() {
        return this.service.store
    }
    get settings() {
        return this.service.settings
    }
    async ensureChannel(shoot, guild, permissions) {
        let channel
        if (shoot.channel_id) {
            channel = await guild.channels.fetch(shoot.channel_id, { force: true }).catch((error) => {
                if (error.code === 10003) return null
                throw error
            })
            if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
                await this.store.updateShoot(shoot.id, { status: 'missing' })
                throw new Error(uiText('shoot.missingChannel'))
            }
        } else {
            const topic = shootTopic(shoot.id)
            const channels = await guild.channels.fetch()
            channel = [...channels.values()].find(
                (candidate) => candidate?.type === ChannelType.GuildText && candidate.topic === topic
            )
            if (!channel) {
                const slug =
                    shoot.name
                        .toLowerCase()
                        .normalize('NFKD')
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '')
                        .slice(0, 70) || 'shoot'
                channel = await guild.channels.create({
                    name: `${slug}-${shoot.id.slice(0, 8)}`,
                    type: ChannelType.GuildText,
                    parent: this.settings.categoryId,
                    topic,
                    permissionOverwrites: permissions,
                    reason: uiText('shoot.reason')
                })
            }
            await this.store.updateShoot(shoot.id, { channel_id: channel.id })
            shoot = await this.store.getShoot(shoot.id, guild.id)
        }
        return { channel, shoot }
    }

    async fetchMessage(channel, id) {
        if (!id) return null
        return channel.messages.fetch({ message: id, force: true }).catch((error) => {
            if (error.code === 10008) return null
            throw error
        })
    }

    async recoverMessage(channel, shoot, kind) {
        const marker = shootMarker(shoot.id, kind)
        let before
        while (true) {
            const page = await channel.messages.fetch({ limit: 100, before })
            const found = [...page.values()].find(
                (message) =>
                    message.author.id === this.client.user.id &&
                    message.embeds.some((embed) => embed.footer?.text === marker)
            )
            if (found) return found
            if (page.size < 100) return null
            before = page.last().id
        }
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
        const payload = renderShoot(invitation ? { ...shoot, announcement_deleted_at: null } : shoot, kind, closed)
        if (kind === 'brief') {
            const names = []
            const guild = await this.client.guilds.fetch(shoot.guild_id)
            for (const row of await this.store.shootParticipants(shoot.id)) {
                if (!row.invited || row.user_id === shoot.organizer_id) continue
                const member = await guild.members.fetch({ user: row.user_id, force: true }).catch((error) => {
                    if (error.code === 10007) return null
                    throw error
                })
                const name =
                    member?.displayName ||
                    member?.user.globalName ||
                    member?.user.username ||
                    uiText('shoot.formerMember', { userId: row.user_id })
                names.push(escapeMarkdown(name.replace(/<@/g, '＜@')).slice(0, 48))
            }
            payload.embeds[0].addFields(
                ...memberFields(uiText('shoot.crewInvited'), names.join(', ') || uiText('shoot.crewEmpty'))
            )
        }
        if (!message) {
            const nonce = crypto
                .createHash('sha256')
                .update(`${shoot.id}:${kind}:${shoot[column] || ''}`)
                .digest('hex')
                .slice(0, 24)
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

    async cleanupAnnouncement(shoot) {
        if (
            (shoot.announcement_deleted_at != null && !shoot.announcement_republish_pending) ||
            !['closing', 'closed', 'missing'].includes(shoot.status)
        )
            return shoot
        const guild = await this.client.guilds.fetch(shoot.guild_id)
        const channel = await guild.channels.fetch(this.settings.announcementChannelId)
        if (shoot.closed_at == null) {
            if (shoot.status === 'missing') return shoot
            // Older releases did not store close times. The existing closed message
            // gives the best available date; persist it once so retries cannot reset it.
            const message = await this.fetchMessage(channel, shoot.announcement_id)
            await this.store.updateShoot(shoot.id, {
                closed_at: message?.editedTimestamp ?? message?.createdTimestamp ?? Date.now()
            })
            shoot = await this.store.getShoot(shoot.id, shoot.guild_id)
        }
        if (Date.now() < shoot.closed_at + 86400000) return shoot
        const messageIds = new Set(shoot.announcement_id ? [shoot.announcement_id] : [])
        if (shoot.announcement_republish_pending) {
            const recovered = await this.recoverMessage(channel, shoot, 'invitation')
            if (recovered) messageIds.add(recovered.id)
        }
        for (const messageId of messageIds) {
            await channel.messages.delete(messageId).catch((error) => {
                if (error.code !== 10008) throw error
            })
        }
        await this.store.updateShoot(shoot.id, {
            announcement_deleted_at: Date.now(),
            announcement_republish_pending: 0
        })
        return this.store.getShoot(shoot.id, shoot.guild_id)
    }
}
module.exports = ShootResources
