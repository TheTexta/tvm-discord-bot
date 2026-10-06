// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const Repository = require('../infrastructure/Repository')
class ShootRepository extends Repository {
    sweepDrafts() {
        return this._locked(async () => {
            const now = Date.now()
            await this._transaction(async () => {
                const cutoff = now - 30 * 60000
                await this._run(
                    `DELETE FROM shoot_participants WHERE shoot_id IN
                    (SELECT id FROM shoots WHERE status = 'draft' AND created_at <= ?)`,
                    [cutoff]
                )
                await this._run("DELETE FROM shoots WHERE status = 'draft' AND created_at <= ?", [cutoff])
            })
        })
    }
    createShootDraft(id, guildId, organizerId, invitedIds) {
        return this._locked(async () => {
            return this._transaction(async () => {
                await this._run(
                    "INSERT INTO shoots (id, guild_id, organizer_id, created_at, join_period) VALUES (?, ?, ?, ?, 'day')",
                    [id, guildId, organizerId, Date.now()]
                )
                for (const userId of new Set([organizerId, ...invitedIds])) {
                    await this._run('INSERT INTO shoot_participants (shoot_id, user_id, invited) VALUES (?, ?, 1)', [
                        id,
                        userId
                    ])
                }
            })
        })
    }
    getShoot(id, guildId) {
        return this._locked(() => this._get('SELECT * FROM shoots WHERE id = ? AND guild_id = ?', [id, guildId]))
    }
    shootForChannel(guildId, channelId) {
        return this._locked(() =>
            this._get('SELECT * FROM shoots WHERE guild_id = ? AND channel_id = ?', [guildId, channelId])
        )
    }
    shootForAnnouncement(guildId, messageId) {
        return this._locked(() =>
            this._get('SELECT * FROM shoots WHERE guild_id = ? AND announcement_id = ?', [guildId, messageId])
        )
    }
    allShoots(guildId) {
        return this._locked(() => this._all("SELECT * FROM shoots WHERE guild_id = ? AND status != 'draft'", [guildId]))
    }
    updateShoot(id, values) {
        const allowed = [
            'name',
            'call_time',
            'location',
            'status',
            'channel_id',
            'brief_id',
            'announcement_id',
            'join_period',
            'join_started_at',
            'announcement_deleted_at',
            'closed_at',
            'announcement_republish_pending'
        ]
        const keys = Object.keys(values)
        if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new Error('Invalid shoot update')
        return this._locked(() =>
            this._run(
                `UPDATE shoots SET ${keys.map((key) => `${key} = ?`).join(', ')},
            revision = revision + 1 WHERE id = ?`,
                [...keys.map((key) => values[key]), id]
            )
        )
    }
    shootParticipants(id) {
        return this._locked(() =>
            this._all('SELECT * FROM shoot_participants WHERE shoot_id = ? ORDER BY user_id', [id])
        )
    }
    setShootReaction(id, userId, reacted, messageId = null) {
        return this._locked(() =>
            this._run(
                `INSERT INTO shoot_participants (shoot_id, user_id, reacted, reaction_message_id) VALUES (?, ?, ?, ?)
            ON CONFLICT(shoot_id, user_id) DO UPDATE SET reacted = excluded.reacted, reaction_message_id = excluded.reaction_message_id`,
                [id, userId, reacted ? 1 : 0, messageId]
            )
        )
    }
    inviteShootParticipant(id, userId) {
        return this._locked(() =>
            this._run(
                `INSERT INTO shoot_participants (shoot_id, user_id, invited) VALUES (?, ?, 1)
            ON CONFLICT(shoot_id, user_id) DO UPDATE SET invited = 1`,
                [id, userId]
            )
        )
    }
}
module.exports = ShootRepository
