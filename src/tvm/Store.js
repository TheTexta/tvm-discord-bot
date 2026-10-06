// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('./uiText')

const fs = require('node:fs')
const path = require('node:path')
const sqlite3 = require('sqlite3').verbose()
const crypto = require('node:crypto')

const { normalizeEmail, validEmail } = require('./validation')
const { rosterRoles, managedColumns } = require('./roles')
const { migrate } = require('./migrations')

class Store {
    constructor(filename, codeSecret) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
        fs.closeSync(fs.openSync(filename, 'a', 0o600))
        fs.chmodSync(filename, 0o600)
        this.db = new sqlite3.Database(filename)
        this.codeSecret = codeSecret
        this.queue = Promise.resolve()
        // Separate table names keep student-number pilot databases ineligible until import.
        this.ready = migrate(this)
    }

    _exec(sql) {
        return new Promise((resolve, reject) => this.db.exec(sql, (error) => (error ? reject(error) : resolve())))
    }
    _run(sql, params = []) {
        return new Promise((resolve, reject) =>
            this.db.run(sql, params, function (error) {
                error ? reject(error) : resolve({ changes: this.changes })
            })
        )
    }
    _get(sql, params = []) {
        return new Promise((resolve, reject) =>
            this.db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)))
        )
    }
    _all(sql, params = []) {
        return new Promise((resolve, reject) =>
            this.db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)))
        )
    }
    // Call inside _locked (or during initialization); never nest transactions.
    async _transaction(work) {
        await this._exec('BEGIN IMMEDIATE')
        try {
            const result = await work()
            await this._exec('COMMIT')
            return result
        } catch (error) {
            await this._exec('ROLLBACK').catch(() => {})
            throw error
        }
    }
    async _locked(work) {
        if (this.closing) throw new Error('Store is closing')
        const next = this.queue.then(async () => {
            await this.ready
            return work()
        })
        this.queue = next.catch(() => {})
        return next
    }
    _emailKey(email) {
        return crypto.createHmac('sha256', this.codeSecret).update(email).digest('hex')
    }
    _hash(userId, guildId, email, version, code) {
        return crypto
            .createHmac('sha256', this.codeSecret)
            .update(JSON.stringify([userId, guildId, email, version, code]))
            .digest('hex')
    }

    status(guildId) {
        return this._locked(async () => {
            const meta = await this._get('SELECT * FROM email_roster_meta WHERE guild_id = ?', [guildId])
            const count = await this._get('SELECT COUNT(*) AS count FROM email_roster WHERE guild_id = ?', [guildId])
            const removed = await this._get(
                `SELECT COUNT(*) AS count FROM email_claims c LEFT JOIN email_roster r
                ON r.guild_id = c.guild_id AND r.email = c.email
                WHERE c.guild_id = ? AND r.email IS NULL`,
                [guildId]
            )
            return { meta, count: count.count, unreconciled: removed.count }
        })
    }
    rosterEntries(guildId) {
        return this._locked(() =>
            this._all('SELECT email, role FROM email_roster WHERE guild_id = ? ORDER BY email', [guildId])
        )
    }
    lookup(guildId, email) {
        return this._locked(() =>
            this._get('SELECT email, role FROM email_roster WHERE guild_id = ? AND email = ?', [
                guildId,
                normalizeEmail(email)
            ])
        )
    }
    replaceRoster(guildId, rows, adminId) {
        return this._locked(async () => {
            if (!Array.isArray(rows) || rows.length === 0) throw new Error(uiText('errors.emptyRoster'))
            if (rows.length > 10000) throw new Error(uiText('errors.rosterRows'))
            const emails = rows.map((row) => normalizeEmail(row?.email))
            if (emails.some((email) => !validEmail(email))) throw new Error(uiText('errors.rosterInvalidEmail'))
            if (new Set(emails).size !== emails.length) throw new Error(uiText('errors.rosterDuplicateEmails'))
            if (rows.some((row) => !rosterRoles.includes(row?.role)))
                throw new Error(uiText('errors.rosterInvalidRole'))
            return this._transaction(async () => {
                const previous = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                await this._run('DELETE FROM email_roster WHERE guild_id = ?', [guildId])
                for (let i = 0; i < rows.length; i++) {
                    await this._run('INSERT INTO email_roster (guild_id, email, role) VALUES (?, ?, ?)', [
                        guildId,
                        emails[i],
                        rows[i].role
                    ])
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ?', [guildId])
                const version = (previous?.version || 0) + 1
                await this._run(
                    `INSERT INTO email_roster_meta (guild_id, version, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(guild_id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                    [guildId, version, Date.now(), adminId]
                )
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)', [
                    guildId,
                    adminId,
                    'roster_replace',
                    JSON.stringify({ version, count: emails.length }),
                    Date.now()
                ])
                return { version, count: emails.length }
            })
        })
    }

    mergeRoster(guildId, rows, adminId) {
        return this._locked(async () => {
            if (!Array.isArray(rows) || rows.length === 0) throw new Error(uiText('errors.emptyRoster'))
            if (rows.length > 10000) throw new Error(uiText('errors.rosterRows'))
            const emails = rows.map((row) => normalizeEmail(row?.email))
            if (emails.some((email) => !validEmail(email))) throw new Error(uiText('errors.rosterInvalidEmail'))
            if (new Set(emails).size !== emails.length) throw new Error(uiText('errors.rosterDuplicateEmails'))
            if (rows.some((row) => !rosterRoles.includes(row?.role)))
                throw new Error(uiText('errors.rosterInvalidRole'))
            return this._transaction(async () => {
                const previous = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                for (let i = 0; i < rows.length; i++) {
                    await this._run(
                        `INSERT INTO email_roster (guild_id, email, role) VALUES (?, ?, ?)
                        ON CONFLICT(guild_id, email) DO UPDATE SET role=excluded.role`,
                        [guildId, emails[i], rows[i].role]
                    )
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ?', [guildId])
                const version = (previous?.version || 0) + 1
                await this._run(
                    `INSERT INTO email_roster_meta (guild_id, version, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(guild_id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                    [guildId, version, Date.now(), adminId]
                )
                const count = (
                    await this._get('SELECT COUNT(*) AS count FROM email_roster WHERE guild_id = ?', [guildId])
                ).count
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)', [
                    guildId,
                    adminId,
                    'roster_merge',
                    JSON.stringify({ version, uploaded: rows.length, count }),
                    Date.now()
                ])
                return { version, uploaded: rows.length, count }
            })
        })
    }

    allowRequest(guildId, userId, email) {
        return this._locked(async () => {
            const emailKey = this._emailKey(normalizeEmail(email))
            const now = Date.now()
            await this._run('DELETE FROM email_request_events WHERE at < ?', [now - 3600000])
            const count = await this._get(
                `SELECT
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN email_key = ? THEN 1 ELSE 0 END) AS email_count
                FROM email_request_events WHERE guild_id = ?`,
                [userId, emailKey, guildId]
            )
            if ((count.user_count || 0) >= 5 || (count.email_count || 0) >= 4) return false
            await this._run('INSERT INTO email_request_events VALUES (?, ?, ?, ?)', [guildId, userId, emailKey, now])
            return true
        })
    }
    reserveSend(guildId, userId, email) {
        return this._locked(async () => {
            const emailKey = this._emailKey(normalizeEmail(email))
            const now = Date.now()
            await this._run('DELETE FROM email_send_events WHERE at < ?', [now - 86400000])
            const counts = await this._get(
                `SELECT
                SUM(CASE WHEN user_id = ? AND at > ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN email_key = ? AND at > ? THEN 1 ELSE 0 END) AS email_count,
                SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS day_count,
                MAX(CASE WHEN user_id = ? OR email_key = ? THEN at ELSE 0 END) AS last_send
                FROM email_send_events WHERE guild_id = ?`,
                [userId, now - 3600000, emailKey, now - 3600000, now - 86400000, userId, emailKey, guildId]
            )
            if (
                (counts.user_count || 0) >= 3 ||
                (counts.email_count || 0) >= 3 ||
                (counts.day_count || 0) >= 80 ||
                now - (counts.last_send || 0) < 60000
            )
                return false
            await this._run('INSERT INTO email_send_events VALUES (?, ?, ?, ?)', [guildId, userId, emailKey, now])
            return true
        })
    }
    savePending(guildId, userId, email, code) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            const meta = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
            const roster = await this._get('SELECT 1 FROM email_roster WHERE guild_id = ? AND email = ?', [
                guildId,
                email
            ])
            if (!meta || !roster) throw new Error(uiText('errors.emailAbsent'))
            return this._run(
                `INSERT INTO email_pending VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(guild_id, user_id) DO UPDATE SET email=excluded.email,
                roster_version=excluded.roster_version, code_hash=excluded.code_hash,
                expires_at=excluded.expires_at, attempts=0`,
                [
                    guildId,
                    userId,
                    email,
                    meta.version,
                    this._hash(userId, guildId, email, meta.version, code),
                    Date.now() + 15 * 60000
                ]
            )
        })
    }
    pendingFor(guildId, userId) {
        return this._locked(() =>
            this._get('SELECT email, expires_at FROM email_pending WHERE guild_id = ? AND user_id = ?', [
                guildId,
                userId
            ])
        )
    }
    verifyAndClaim(guildId, userId, code, existingRoles = {}) {
        return this._locked(async () => {
            return this._transaction(async () => {
                const pending = await this._get('SELECT * FROM email_pending WHERE guild_id = ? AND user_id = ?', [
                    guildId,
                    userId
                ])
                if (!pending || pending.expires_at < Date.now() || pending.attempts >= 5) {
                    return { ok: false, reason: 'expired' }
                }
                const expected = Buffer.from(pending.code_hash, 'hex')
                const supplied = Buffer.from(
                    this._hash(userId, guildId, pending.email, pending.roster_version, code),
                    'hex'
                )
                if (!crypto.timingSafeEqual(expected, supplied)) {
                    await this._run(
                        'UPDATE email_pending SET attempts = attempts + 1 WHERE guild_id = ? AND user_id = ?',
                        [guildId, userId]
                    )
                    return { ok: false, reason: 'invalid' }
                }
                const roster = await this._get('SELECT role FROM email_roster WHERE guild_id = ? AND email = ?', [
                    guildId,
                    pending.email
                ])
                const meta = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                if (!meta || meta.version !== pending.roster_version || !roster) {
                    await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    return { ok: false, reason: 'ineligible' }
                }
                const holder = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [
                    guildId,
                    pending.email
                ])
                const own = await this._get('SELECT email FROM email_claims WHERE guild_id = ? AND user_id = ?', [
                    guildId,
                    userId
                ])
                if ((holder && holder.user_id !== userId) || (own && own.email !== pending.email)) {
                    await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    return { ok: false, reason: 'claimed' }
                }
                const created = !holder
                if (created) {
                    await this._run(
                        `INSERT INTO email_claims (guild_id, email, user_id, created_at, managed_role, managed_exec_role, managed_admin_role)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [
                            guildId,
                            pending.email,
                            userId,
                            Date.now(),
                            existingRoles.member ? 0 : 1,
                            roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                            roster.role === 'admin' && !existingRoles.admin ? 1 : 0
                        ]
                    )
                } else {
                    await this._run(
                        `UPDATE email_claims SET
                        managed_role = CASE WHEN ? THEN managed_role ELSE 1 END,
                        managed_exec_role = CASE WHEN ? THEN 1 ELSE managed_exec_role END,
                        managed_admin_role = CASE WHEN ? THEN 1 ELSE managed_admin_role END
                        WHERE guild_id = ? AND email = ?`,
                        [
                            existingRoles.member ? 1 : 0,
                            roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                            roster.role === 'admin' && !existingRoles.admin ? 1 : 0,
                            guildId,
                            pending.email
                        ]
                    )
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                return { ok: true, email: pending.email, role: roster.role, created }
            })
        })
    }

    releaseRemovedClaim(guildId, email, userId) {
        return this._locked(() =>
            this._run('DELETE FROM email_claims WHERE guild_id = ? AND email = ? AND user_id = ?', [
                guildId,
                normalizeEmail(email),
                userId
            ])
        )
    }
    removedClaims(guildId) {
        return this._locked(() =>
            this._all(
                `SELECT c.email, c.user_id, c.managed_role, c.managed_exec_role, c.managed_admin_role FROM email_claims c LEFT JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ? AND r.email IS NULL`,
                [guildId]
            )
        )
    }
    activeClaims(guildId) {
        return this._locked(() =>
            this._all(
                `SELECT c.email, c.user_id, c.managed_role, c.managed_exec_role, c.managed_admin_role, r.role
            FROM email_claims c JOIN email_roster r ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ?`,
                [guildId]
            )
        )
    }
    activeClaimUserIds(guildId) {
        return this._locked(
            async () =>
                new Set(
                    (
                        await this._all(
                            `SELECT c.user_id FROM email_claims c INNER JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ?`,
                            [guildId]
                        )
                    ).map((row) => row.user_id)
                )
        )
    }
    isAuthorizedUser(guildId, userId) {
        return this._locked(
            async () =>
                !!(await this._get(
                    `SELECT 1 FROM email_claims c INNER JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ? AND c.user_id = ?`,
                    [guildId, userId]
                ))
        )
    }
    claimForUser(guildId, userId) {
        return this._locked(() =>
            this._get('SELECT email FROM email_claims WHERE guild_id = ? AND user_id = ?', [guildId, userId])
        )
    }
    claimFor(guildId, email) {
        return this._locked(() =>
            this._get(
                'SELECT user_id, managed_role, managed_exec_role, managed_admin_role FROM email_claims WHERE guild_id = ? AND email = ?',
                [guildId, normalizeEmail(email)]
            )
        )
    }
    markRoleManaged(guildId, email, userId, kind = 'member') {
        const column = managedColumns[kind]
        if (!column) throw new Error(uiText('errors.invalidRoleKind'))
        return this._locked(() =>
            this._run(
                `UPDATE email_claims SET ${column} = 1
            WHERE guild_id = ? AND email = ? AND user_id = ?`,
                [guildId, normalizeEmail(email), userId]
            )
        )
    }
    clearRoleManaged(guildId, email, userId, kind) {
        const column = managedColumns[kind]
        if (!column) throw new Error(uiText('errors.invalidRoleKind'))
        return this._locked(() =>
            this._run(
                `UPDATE email_claims SET ${column} = 0
            WHERE guild_id = ? AND email = ? AND user_id = ?`,
                [guildId, normalizeEmail(email), userId]
            )
        )
    }
    releaseClaim(guildId, email, adminId) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            return this._transaction(async () => {
                const claim = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [
                    guildId,
                    email
                ])
                if (!claim) throw new Error(uiText('errors.noClaim'))
                await this._run('DELETE FROM email_claims WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)', [
                    guildId,
                    adminId,
                    'claim_release',
                    JSON.stringify({ emailKey: this._emailKey(email), userId: claim.user_id }),
                    Date.now()
                ])
                return claim.user_id
            })
        })
    }
    transfer(guildId, email, userId, adminId = 'system', existingRoles = {}) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            return this._transaction(async () => {
                const roster = await this._get('SELECT role FROM email_roster WHERE guild_id = ? AND email = ?', [
                    guildId,
                    email
                ])
                if (!roster) throw new Error(uiText('errors.emailAbsent'))
                const prior = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [
                    guildId,
                    email
                ])
                if (!prior) throw new Error(uiText('errors.noClaim'))
                const other = await this._get(
                    'SELECT 1 FROM email_claims WHERE guild_id = ? AND user_id = ? AND email != ?',
                    [guildId, userId, email]
                )
                if (other) throw new Error(uiText('errors.targetClaimed'))
                await this._run(
                    `UPDATE email_claims SET user_id = ?, created_at = ?, managed_role = ?,
                    managed_exec_role = ?, managed_admin_role = ? WHERE guild_id = ? AND email = ?`,
                    [
                        userId,
                        Date.now(),
                        existingRoles.member ? 0 : 1,
                        roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                        roster.role === 'admin' && !existingRoles.admin ? 1 : 0,
                        guildId,
                        email
                    ]
                )
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)', [
                    guildId,
                    adminId,
                    'account_transfer',
                    JSON.stringify({ emailKey: this._emailKey(email), from: prior.user_id, to: userId }),
                    Date.now()
                ])
                return prior.user_id
            })
        })
    }
    audit(guildId) {
        return this._locked(() =>
            this._all(
                'SELECT actor_id, action, detail, at FROM email_admin_audit WHERE guild_id = ? ORDER BY at DESC LIMIT 10',
                [guildId]
            )
        )
    }
    sweep() {
        return this._locked(async () => {
            const now = Date.now()
            await this._run('DELETE FROM email_pending WHERE expires_at < ?', [now])
            await this._run('DELETE FROM email_request_events WHERE at < ?', [now - 3600000])
            await this._run('DELETE FROM email_send_events WHERE at < ?', [now - 86400000])
            await this._run('DELETE FROM email_admin_audit WHERE at < ?', [now - 365 * 86400000])
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
    close() {
        if (!this.closePromise) {
            this.closing = true
            this.closePromise = (async () => {
                await this.ready.catch(() => {})
                await this.queue
                await new Promise((resolve, reject) => this.db.close((error) => (error ? reject(error) : resolve())))
            })()
        }
        return this.closePromise
    }
}

module.exports = Store
