// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const sqlite3 = require('sqlite3').verbose()

const { migrate } = require('./migrations')

class SqliteDatabase {
    constructor(filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
        fs.closeSync(fs.openSync(filename, 'a', 0o600))
        fs.chmodSync(filename, 0o600)
        this.db = new sqlite3.Database(filename)
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

module.exports = SqliteDatabase
