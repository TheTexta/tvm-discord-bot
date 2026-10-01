// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const sqlite3 = require('sqlite3').verbose()
const crypto = require('node:crypto')

class Store {
    constructor(filename, codeSecret) {
        process.umask(0o077)
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
        fs.closeSync(fs.openSync(filename, 'a', 0o600))
        fs.chmodSync(filename, 0o600)
        this.db = new sqlite3.Database(filename)
        this.codeSecret = codeSecret
        this.queue = Promise.resolve()
        this.ready = this._exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS roster (guild_id TEXT NOT NULL, student_id TEXT NOT NULL, email TEXT NOT NULL,
                PRIMARY KEY (guild_id, student_id), UNIQUE (guild_id, email));
            CREATE TABLE IF NOT EXISTS roster_meta (guild_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS claims (guild_id TEXT NOT NULL, student_id TEXT NOT NULL, user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, student_id), UNIQUE (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS pending (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, student_id TEXT NOT NULL,
                email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS request_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, student_id TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_request_events_at ON request_events(at);
            CREATE TABLE IF NOT EXISTS send_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, student_id TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_send_events_at ON send_events(at);
            CREATE TABLE IF NOT EXISTS admin_audit (guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
                detail TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_admin_audit_guild_at ON admin_audit(guild_id, at);
        `)
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
    _hash(userId, guildId, studentId, email, code) {
        return crypto.createHmac('sha256', this.codeSecret)
            .update(JSON.stringify([userId, guildId, studentId, email, code])).digest('hex')
    }

    status(guildId) {
        return this._locked(async () => {
            const meta = await this._get('SELECT * FROM roster_meta WHERE guild_id = ?', [guildId])
            const count = await this._get('SELECT COUNT(*) AS count FROM roster WHERE guild_id = ?', [guildId])
            const removed = await this._get(`SELECT COUNT(*) AS count FROM claims c LEFT JOIN roster r
                ON r.guild_id = c.guild_id AND r.student_id = c.student_id
                WHERE c.guild_id = ? AND r.student_id IS NULL`, [guildId])
            return { meta, count: count.count, unreconciled: removed.count }
        })
    }

    lookup(guildId, studentId) {
        return this._locked(() => this._get('SELECT email FROM roster WHERE guild_id = ? AND student_id = ?', [guildId, studentId]))
    }

    async replaceRoster(guildId, rows, adminId) {
        return this._locked(async () => {
            await this._exec('BEGIN IMMEDIATE')
            try {
                const previous = await this._get('SELECT version FROM roster_meta WHERE guild_id = ?', [guildId])
                await this._run('DELETE FROM roster WHERE guild_id = ?', [guildId])
                for (const row of rows) {
                    await this._run('INSERT INTO roster (guild_id, student_id, email) VALUES (?, ?, ?)', [guildId, row.studentId, row.email])
                }
                await this._run('DELETE FROM pending WHERE guild_id = ?', [guildId])
                const version = (previous?.version || 0) + 1
                await this._run(`INSERT INTO roster_meta (guild_id, version, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(guild_id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                    [guildId, version, Date.now(), adminId])
                await this._run('INSERT INTO admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'roster_replace', JSON.stringify({ version, count: rows.length }), Date.now()])
                await this._exec('COMMIT')
                return { version, count: rows.length }
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }

    allowRequest(guildId, userId, studentId) {
        return this._locked(async () => {
            const now = Date.now()
            await this._run('DELETE FROM request_events WHERE at < ?', [now - 3600000])
            const count = await this._get(`SELECT
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN student_id = ? THEN 1 ELSE 0 END) AS student_count
                FROM request_events WHERE guild_id = ?`, [userId, studentId, guildId])
            if ((count.user_count || 0) >= 5 || (count.student_count || 0) >= 4) return false
            await this._run('INSERT INTO request_events VALUES (?, ?, ?, ?)', [guildId, userId, studentId, now])
            return true
        })
    }

    reserveSend(guildId, userId, studentId) {
        return this._locked(async () => {
            const now = Date.now()
            await this._run('DELETE FROM send_events WHERE at < ?', [now - 86400000])
            const counts = await this._get(`SELECT
                SUM(CASE WHEN user_id = ? AND at > ? THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN student_id = ? AND at > ? THEN 1 ELSE 0 END) AS student_count,
                SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS day_count,
                MAX(CASE WHEN user_id = ? OR student_id = ? THEN at ELSE 0 END) AS last_send
                FROM send_events WHERE guild_id = ?`,
            [userId, now - 3600000, studentId, now - 3600000, now - 86400000, userId, studentId, guildId])
            if ((counts.user_count || 0) >= 3 || (counts.student_count || 0) >= 3 ||
                (counts.day_count || 0) >= 80 || now - (counts.last_send || 0) < 60000) return false
            await this._run('INSERT INTO send_events VALUES (?, ?, ?, ?)', [guildId, userId, studentId, now])
            return true
        })
    }

    savePending(guildId, userId, studentId, email, code) {
        return this._locked(() => this._run(`INSERT INTO pending VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET student_id=excluded.student_id, email=excluded.email,
            code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`,
        [guildId, userId, studentId, email, this._hash(userId, guildId, studentId, email, code), Date.now() + 15 * 60000]))
    }

    pendingFor(guildId, userId) {
        return this._locked(() => this._get('SELECT student_id, email, expires_at FROM pending WHERE guild_id = ? AND user_id = ?', [guildId, userId]))
    }

    verifyAndClaim(guildId, userId, code) {
        return this._locked(async () => {
            await this._exec('BEGIN IMMEDIATE')
            try {
                const pending = await this._get('SELECT * FROM pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                if (!pending || pending.expires_at < Date.now() || pending.attempts >= 5) {
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'expired' }
                }
                const expected = Buffer.from(pending.code_hash, 'hex')
                const supplied = Buffer.from(this._hash(userId, guildId, pending.student_id, pending.email, code), 'hex')
                if (!crypto.timingSafeEqual(expected, supplied)) {
                    await this._run('UPDATE pending SET attempts = attempts + 1 WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'invalid' }
                }
                const roster = await this._get('SELECT email FROM roster WHERE guild_id = ? AND student_id = ?', [guildId, pending.student_id])
                const meta = await this._get('SELECT 1 FROM roster_meta WHERE guild_id = ?', [guildId])
                if (!meta || !roster || roster.email !== pending.email) {
                    await this._run('DELETE FROM pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'ineligible' }
                }
                const holder = await this._get('SELECT user_id FROM claims WHERE guild_id = ? AND student_id = ?', [guildId, pending.student_id])
                const own = await this._get('SELECT student_id FROM claims WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                if ((holder && holder.user_id !== userId) || (own && own.student_id !== pending.student_id)) {
                    await this._run('DELETE FROM pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                    await this._exec('COMMIT')
                    return { ok: false, reason: 'claimed' }
                }
                const created = !holder
                if (created) await this._run('INSERT INTO claims VALUES (?, ?, ?, ?)', [guildId, pending.student_id, userId, Date.now()])
                await this._run('DELETE FROM pending WHERE guild_id = ? AND user_id = ?', [guildId, userId])
                await this._exec('COMMIT')
                return { ok: true, studentId: pending.student_id, created }
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }

    releaseNewClaim(guildId, studentId, userId) {
        return this._locked(() => this._run('DELETE FROM claims WHERE guild_id = ? AND student_id = ? AND user_id = ?', [guildId, studentId, userId]))
    }
    removedClaims(guildId) {
        return this._locked(() => this._all(`SELECT c.student_id, c.user_id FROM claims c LEFT JOIN roster r
            ON r.guild_id = c.guild_id AND r.student_id = c.student_id
            WHERE c.guild_id = ? AND r.student_id IS NULL`, [guildId]))
    }
    activeClaimUserIds(guildId) {
        return this._locked(async () => new Set((await this._all(`SELECT c.user_id FROM claims c INNER JOIN roster r
            ON r.guild_id = c.guild_id AND r.student_id = c.student_id
            WHERE c.guild_id = ?`, [guildId])).map(row => row.user_id)))
    }
    isAuthorizedUser(guildId, userId) {
        return this._locked(async () => !!(await this._get(`SELECT 1 FROM claims c INNER JOIN roster r
            ON r.guild_id = c.guild_id AND r.student_id = c.student_id
            WHERE c.guild_id = ? AND c.user_id = ?`, [guildId, userId])))
    }
    claimFor(guildId, studentId) {
        return this._locked(() => this._get('SELECT user_id FROM claims WHERE guild_id = ? AND student_id = ?', [guildId, studentId]))
    }
    releaseClaim(guildId, studentId, adminId) {
        return this._locked(async () => {
            await this._exec('BEGIN IMMEDIATE')
            try {
                const claim = await this._get('SELECT user_id FROM claims WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                if (!claim) throw new Error('Student ID has no existing claim')
                await this._run('DELETE FROM claims WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                await this._run('DELETE FROM pending WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                await this._run('INSERT INTO admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'claim_release', JSON.stringify({ studentId, userId: claim.user_id }), Date.now()])
                await this._exec('COMMIT')
                return claim.user_id
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }
    transfer(guildId, studentId, userId, adminId = 'system') {
        return this._locked(async () => {
            await this._exec('BEGIN IMMEDIATE')
            try {
                const roster = await this._get('SELECT 1 FROM roster WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                if (!roster) throw new Error('Student ID is absent from the active roster')
                const prior = await this._get('SELECT user_id FROM claims WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                if (!prior) throw new Error('Student ID has no existing claim')
                const other = await this._get('SELECT 1 FROM claims WHERE guild_id = ? AND user_id = ? AND student_id != ?', [guildId, userId, studentId])
                if (other) throw new Error('Target Discord account already claims another roster member')
                await this._run('UPDATE claims SET user_id = ?, created_at = ? WHERE guild_id = ? AND student_id = ?', [userId, Date.now(), guildId, studentId])
                await this._run('DELETE FROM pending WHERE guild_id = ? AND student_id = ?', [guildId, studentId])
                await this._run('INSERT INTO admin_audit VALUES (?, ?, ?, ?, ?)',
                    [guildId, adminId, 'account_transfer', JSON.stringify({ studentId, from: prior.user_id, to: userId }), Date.now()])
                await this._exec('COMMIT')
                return prior.user_id
            } catch (error) {
                await this._exec('ROLLBACK').catch(() => {})
                throw error
            }
        })
    }
    audit(guildId) {
        return this._locked(() => this._all('SELECT actor_id, action, detail, at FROM admin_audit WHERE guild_id = ? ORDER BY at DESC LIMIT 10', [guildId]))
    }
    sweep() {
        return this._locked(async () => {
            const now = Date.now()
            await this._run('DELETE FROM pending WHERE expires_at < ?', [now])
            await this._run('DELETE FROM request_events WHERE at < ?', [now - 3600000])
            await this._run('DELETE FROM send_events WHERE at < ?', [now - 86400000])
            await this._run('DELETE FROM admin_audit WHERE at < ?', [now - 365 * 86400000])
        })
    }
    close() { return new Promise((resolve, reject) => this.db.close(error => error ? reject(error) : resolve())) }
}

module.exports = Store
