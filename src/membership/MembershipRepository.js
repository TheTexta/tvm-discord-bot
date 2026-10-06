// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const Repository = require('../infrastructure/Repository')
const crypto = require('node:crypto')
const { uiText } = require('../shared/uiText')
const { normalizeEmail, validEmail } = require('../shared/validation')
const { rosterRoles, managedColumns } = require('./roles')

class MembershipRepository extends Repository {
    constructor(database, codeSecret) {
        super(database)
        this.codeSecret = codeSecret
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
            const emailSet = new Set(emails)
            if (emails.some((email) => !validEmail(email))) throw new Error(uiText('errors.rosterInvalidEmail'))
            if (emailSet.size !== emails.length) throw new Error(uiText('errors.rosterDuplicateEmails'))
            if (rows.some((row) => !rosterRoles.includes(row?.role)))
                throw new Error(uiText('errors.rosterInvalidRole'))
            return this._transaction(async () => {
                const previous = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                const before = new Map(
                    (await this._all('SELECT email, role FROM email_roster WHERE guild_id = ?', [guildId])).map(
                        (row) => [row.email, row.role]
                    )
                )
                const added = emails.filter((email) => !before.has(email)).length
                const changed = emails.filter(
                    (email, i) => before.has(email) && before.get(email) !== rows[i].role
                ).length
                const omitted = [...before.keys()].filter((email) => !emailSet.has(email)).length
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
                    `INSERT INTO email_roster_meta (guild_id, version, updated_at, updated_by, authoritative) VALUES (?, ?, ?, ?, 1)
                    ON CONFLICT(guild_id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by, authoritative=1`,
                    [guildId, version, Date.now(), adminId]
                )
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)', [
                    guildId,
                    adminId,
                    'roster_replace',
                    JSON.stringify({ version, count: emails.length, added, changed, omitted }),
                    Date.now()
                ])
                return { version, count: emails.length, uploaded: emails.length, added, changed, omitted }
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
    verifyAndClaim(guildId, userId, code) {
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
                        'INSERT INTO email_claims (guild_id, email, user_id, created_at) VALUES (?, ?, ?, ?)',
                        [guildId, pending.email, userId, Date.now()]
                    )
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                return { ok: true, email: pending.email, role: roster.role, created }
            })
        })
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
            this._get(
                `SELECT c.*, r.role FROM email_claims c LEFT JOIN email_roster r ON r.guild_id=c.guild_id AND r.email=c.email WHERE c.guild_id = ? AND c.user_id = ?`,
                [guildId, userId]
            )
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
    transfer(guildId, email, userId, adminId = 'system') {
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
                    `UPDATE email_claims SET user_id = ?, created_at = ?, managed_role = 0,
                    managed_exec_role = 0, managed_admin_role = 0 WHERE guild_id = ? AND email = ?`,
                    [userId, Date.now(), guildId, email]
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
        })
    }
}
module.exports = MembershipRepository
