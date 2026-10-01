// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const sqlite3 = require('sqlite3').verbose()
const crypto = require('node:crypto')

const normalizeEmail = value => String(value ?? '').trim().toLowerCase()
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

class Store {
    constructor(filename, codeSecret) {
        process.umask(0o077)
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
        fs.closeSync(fs.openSync(filename, 'a', 0o600))
        fs.chmodSync(filename, 0o600)
        this.db = new sqlite3.Database(filename)
        this.codeSecret = codeSecret
        this.queue = Promise.resolve()
        // New table names make a database from the earlier student-number pilot fail
        // closed: it has no active email roster or claims until an email list is imported.
        this.ready = this._exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS email_roster (guild_id TEXT NOT NULL, email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'gm',
                PRIMARY KEY (guild_id, email));
            CREATE TABLE IF NOT EXISTS email_roster_meta (guild_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS email_claims (guild_id TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL, managed_role INTEGER NOT NULL DEFAULT 0,
                managed_exec_role INTEGER NOT NULL DEFAULT 0, managed_admin_role INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (guild_id, email), UNIQUE (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS email_pending (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL,
                roster_version INTEGER NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS email_request_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                email_key TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_request_events_at ON email_request_events(at);
            CREATE TABLE IF NOT EXISTS email_send_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                email_key TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_send_events_at ON email_send_events(at);
            CREATE TABLE IF NOT EXISTS email_admin_audit (guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_admin_audit_guild_at ON email_admin_audit(guild_id, at);
        `).then(async () => {
            for (const [table, column, declaration] of [
                ['email_roster', 'role', "TEXT NOT NULL DEFAULT 'gm'"],
                ['email_claims', 'managed_role', 'INTEGER NOT NULL DEFAULT 0'],
                ['email_claims', 'managed_exec_role', 'INTEGER NOT NULL DEFAULT 0'],
                ['email_claims', 'managed_admin_role', 'INTEGER NOT NULL DEFAULT 0']
            ]) {
                const columns = await this._all(`PRAGMA table_info(${table})`)
                if (!columns.some(item => item.name === column)) await this._exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
            }
        })
    }

    _exec(sql) { return new Promise((resolve, reject) => this.db.exec(sql, error => error ? reject(error) : resolve())) }
    _run(sql, params = []) { return new Promise((resolve, reject) => this.db.run(sql, params, function (error) { error ? reject(error) : resolve({ changes: this.changes }) })) }
    _get(sql, params = []) { return new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))) }
    _all(sql, params = []) { return new Promise((resolve, reject) => this.db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))) }
    async _locked(work) {
        const next = this.queue.then(async () => { await this.ready; return work() })
        this.queue = next.catch(() => {})
        return next
    }
    _emailKey(email) {
        return crypto.createHmac('sha256', this.codeSecret).update(email).digest('hex')
    }
    _hash(userId, guildId, email, version, code) {
        return crypto.createHmac('sha256', this.codeSecret)
            .update(JSON.stringify([userId, guildId, email, version, code])).digest('hex')
    }

    status(guildId) {
        return this._locked(async () => {
            const meta = await this._get('SELECT * FROM email_roster_meta WHERE guild_id = ?', [guildId])
            const count = await this._get('SELECT COUNT(*) AS count FROM email_roster WHERE guild_id = ?', [guildId])
            const removed = await this._get(`SELECT COUNT(*) AS count FROM email_claims c LEFT JOIN email_roster r
                ON r.guild_id = c.guild_id AND r.email = c.email
                WHERE c.guild_id = ? AND r.email IS NULL`, [guildId])
            return { meta, count: count.count, unreconciled: removed.count }
        })
    }
    lookup(guildId, email) {
        return this._locked(() => this._get('SELECT email, role FROM email_roster WHERE guild_id = ? AND email = ?',
            [guildId, normalizeEmail(email)]))
    }
    replaceRoster(guildId, rows, adminId) {
        return this._locked(async () => {
            if (!Array.isArray(rows) || rows.length === 0) throw new Error('Roster cannot be empty')
            if (rows.length > 10000) throw new Error('Roster exceeds 10,000 rows')
            const emails = rows.map(row => normalizeEmail(row?.email))
            if (emails.some(email => !validEmail(email))) throw new Error('Roster contains an invalid email')
            if (new Set(emails).size !== emails.length) throw new Error('Roster contains duplicate emails')
            if (rows.some(row => !['gm', 'exec', 'admin'].includes(row?.role))) throw new Error('Roster contains an invalid role')
            await this._exec('BEGIN IMMEDIATE')
            try {
                const previous = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                await this._run('DELETE FROM email_roster WHERE guild_id = ?', [guildId])
                for (let i = 0; i < rows.length; i++) {
                    await this._run('INSERT INTO email_roster (guild_id, email, role) VALUES (?, ?, ?)', [guildId, emails[i], rows[i].role])
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ?', [guildId])
                const version = (previous?.version || 0) + 1
                await this._run(`INSERT INTO email_roster_meta (guild_id, version, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(guild_id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                    [guildId, version, Date.now(), adminId])
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'roster_replace', JSON.stringify({ version, count: emails.length }), Date.now()])
                await this._exec('COMMIT')
                return { version, count: emails.length }
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }

    allowRequest(guildId, userId, email) {
        return this._locked(async () => {
            const emailKey = this._emailKey(normalizeEmail(email))
            const now = Date.now()
            await this._run('DELETE FROM email_request_events WHERE at < ?', [now - 3600000])
            const count = await this._get(`SELECT
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN email_key = ? THEN 1 ELSE 0 END) AS email_count
                FROM email_request_events WHERE guild_id = ?`, [userId, emailKey, guildId])
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
            const counts = await this._get(`SELECT
                SUM(CASE WHEN user_id = ? AND at > ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN email_key = ? AND at > ? THEN 1 ELSE 0 END) AS email_count,
                SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS day_count,
                MAX(CASE WHEN user_id = ? OR email_key = ? THEN at ELSE 0 END) AS last_send
                FROM email_send_events WHERE guild_id = ?`,
            [userId, now - 3600000, emailKey, now - 3600000, now - 86400000, userId, emailKey, guildId])
            if ((counts.user_count || 0) >= 3 || (counts.email_count || 0) >= 3 ||
                (counts.day_count || 0) >= 80 || now - (counts.last_send || 0) < 60000) return false
            await this._run('INSERT INTO email_send_events VALUES (?, ?, ?, ?)', [guildId, userId, emailKey, now])
            return true
        })
    }
    savePending(guildId, userId, email, code) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            const meta = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
            const roster = await this._get('SELECT 1 FROM email_roster WHERE guild_id = ? AND email = ?', [guildId, email])
            if (!meta || !roster) throw new Error('Email is absent from the active roster')
            return this._run(`INSERT INTO email_pending VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(guild_id, user_id) DO UPDATE SET email=excluded.email,
                roster_version=excluded.roster_version, code_hash=excluded.code_hash,
                expires_at=excluded.expires_at, attempts=0`,
            [guildId, userId, email, meta.version, this._hash(userId, guildId, email, meta.version, code),
                Date.now() + 15 * 60000])
        })
    }
    pendingFor(guildId, userId) {
        return this._locked(() => this._get('SELECT email, expires_at FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId]))
    }
    verifyAndClaim(guildId, userId, code, existingRoles = {}) {
        return this._locked(async () => {
            await this._exec('BEGIN IMMEDIATE')
            try {
                const pending = await this._get('SELECT * FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                if (!pending || pending.expires_at < Date.now() || pending.attempts >= 5) {
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'expired' }
                }
                const expected = Buffer.from(pending.code_hash, 'hex')
                const supplied = Buffer.from(this._hash(userId, guildId, pending.email, pending.roster_version, code), 'hex')
                if (!crypto.timingSafeEqual(expected, supplied)) {
                    await this._run('UPDATE email_pending SET attempts = attempts + 1 WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'invalid' }
                }
                const roster = await this._get('SELECT role FROM email_roster WHERE guild_id = ? AND email = ?', [guildId, pending.email])
                const meta = await this._get('SELECT version FROM email_roster_meta WHERE guild_id = ?', [guildId])
                if (!meta || meta.version !== pending.roster_version || !roster) {
                    await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'ineligible' }
                }
                const holder = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [guildId, pending.email])
                const own = await this._get('SELECT email FROM email_claims WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                if ((holder && holder.user_id !== userId) || (own && own.email !== pending.email)) {
                    await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'claimed' }
                }
                const created = !holder
                if (created) {
                    await this._run(`INSERT INTO email_claims (guild_id, email, user_id, created_at, managed_role, managed_exec_role, managed_admin_role)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`, [guildId, pending.email, userId, Date.now(),
                        existingRoles.member ? 0 : 1,
                        roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                        roster.role === 'admin' && !existingRoles.admin ? 1 : 0])
                } else {
                    await this._run(`UPDATE email_claims SET
                        managed_role = CASE WHEN ? THEN managed_role ELSE 1 END,
                        managed_exec_role = CASE WHEN ? THEN 1 ELSE managed_exec_role END,
                        managed_admin_role = CASE WHEN ? THEN 1 ELSE managed_admin_role END
                        WHERE guild_id = ? AND email = ?`, [existingRoles.member ? 1 : 0,
                        roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                        roster.role === 'admin' && !existingRoles.admin ? 1 : 0,
                        guildId, pending.email])
                }
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                await this._exec('COMMIT')
                return { ok: true, email: pending.email, role: roster.role, created }
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }

    releaseRemovedClaim(guildId, email, userId) {
        return this._locked(() => this._run('DELETE FROM email_claims WHERE guild_id = ? AND email = ? AND user_id = ?',
            [guildId, normalizeEmail(email), userId]))
    }
    removedClaims(guildId) {
        return this._locked(() => this._all(`SELECT c.email, c.user_id, c.managed_role, c.managed_exec_role, c.managed_admin_role FROM email_claims c LEFT JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ? AND r.email IS NULL`, [guildId]))
    }
    activeClaims(guildId) {
        return this._locked(() => this._all(`SELECT c.email, c.user_id, c.managed_role, c.managed_exec_role, c.managed_admin_role, r.role
            FROM email_claims c JOIN email_roster r ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ?`, [guildId]))
    }
    activeClaimUserIds(guildId) {
        return this._locked(async () => new Set((await this._all(`SELECT c.user_id FROM email_claims c INNER JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ?`, [guildId])).map(row => row.user_id)))
    }
    isAuthorizedUser(guildId, userId) {
        return this._locked(async () => !!(await this._get(`SELECT 1 FROM email_claims c INNER JOIN email_roster r
            ON r.guild_id = c.guild_id AND r.email = c.email
            WHERE c.guild_id = ? AND c.user_id = ?`, [guildId, userId])))
    }
    claimFor(guildId, email) {
        return this._locked(() => this._get('SELECT user_id, managed_role, managed_exec_role, managed_admin_role FROM email_claims WHERE guild_id = ? AND email = ?',
            [guildId, normalizeEmail(email)]))
    }
    markRoleManaged(guildId, email, userId, kind = 'member') {
        const column = { member: 'managed_role', exec: 'managed_exec_role', admin: 'managed_admin_role' }[kind]
        if (!column) throw new Error('Invalid role kind')
        return this._locked(() => this._run(`UPDATE email_claims SET ${column} = 1
            WHERE guild_id = ? AND email = ? AND user_id = ?`, [guildId, normalizeEmail(email), userId]))
    }
    clearRoleManaged(guildId, email, userId, kind) {
        const column = { member: 'managed_role', exec: 'managed_exec_role', admin: 'managed_admin_role' }[kind]
        if (!column) throw new Error('Invalid role kind')
        return this._locked(() => this._run(`UPDATE email_claims SET ${column} = 0
            WHERE guild_id = ? AND email = ? AND user_id = ?`, [guildId, normalizeEmail(email), userId]))
    }
    releaseClaim(guildId, email, adminId) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            await this._exec('BEGIN IMMEDIATE')
            try {
                const claim = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [guildId, email])
                if (!claim) throw new Error('Email has no existing claim')
                await this._run('DELETE FROM email_claims WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'claim_release', JSON.stringify({ emailKey: this._emailKey(email), userId: claim.user_id }), Date.now()])
                await this._exec('COMMIT')
                return claim.user_id
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }
    transfer(guildId, email, userId, adminId = 'system', existingRoles = {}) {
        return this._locked(async () => {
            email = normalizeEmail(email)
            await this._exec('BEGIN IMMEDIATE')
            try {
                const roster = await this._get('SELECT role FROM email_roster WHERE guild_id = ? AND email = ?', [guildId, email])
                if (!roster) throw new Error('Email is absent from the active roster')
                const prior = await this._get('SELECT user_id FROM email_claims WHERE guild_id = ? AND email = ?', [guildId, email])
                if (!prior) throw new Error('Email has no existing claim')
                const other = await this._get('SELECT 1 FROM email_claims WHERE guild_id = ? AND user_id = ? AND email != ?', [guildId, userId, email])
                if (other) throw new Error('Target Discord account already claims another roster email')
                await this._run(`UPDATE email_claims SET user_id = ?, created_at = ?, managed_role = ?,
                    managed_exec_role = ?, managed_admin_role = ? WHERE guild_id = ? AND email = ?`,
                    [userId, Date.now(), existingRoles.member ? 0 : 1,
                        roster.role === 'exec' && !existingRoles.exec ? 1 : 0,
                        roster.role === 'admin' && !existingRoles.admin ? 1 : 0, guildId, email])
                await this._run('DELETE FROM email_pending WHERE guild_id = ? AND email = ?', [guildId, email])
                await this._run('INSERT INTO email_admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'account_transfer', JSON.stringify({ emailKey: this._emailKey(email), from: prior.user_id, to: userId }), Date.now()])
                await this._exec('COMMIT')
                return prior.user_id
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }
    audit(guildId) {
        return this._locked(() => this._all('SELECT actor_id, action, detail, at FROM email_admin_audit WHERE guild_id = ? ORDER BY at DESC LIMIT 10', [guildId]))
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
    close() { return new Promise((resolve, reject) => this.db.close(error => error ? reject(error) : resolve())) }
}

module.exports = Store
