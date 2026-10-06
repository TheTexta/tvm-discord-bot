// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const fs = require('node:fs/promises')
const healthPath = (databasePath) => `${databasePath}.health.json`

function checkHealth(value, now = Date.now()) {
    const fresh = (at, age) => Number.isFinite(at) && at <= now && now - at < age
    if (!fresh(value?.at, 60000)) throw new Error('Health heartbeat is stale')
    if (value.state !== 'ready' || !value.connected) throw new Error('Discord runtime is not ready and connected')
    if (!fresh(value.membershipLastSuccessAt, 2 * 3600000)) throw new Error('Membership reconciliation is overdue')
    if (value.shootsEnabled && !fresh(value.shootLastSuccessAt, 5 * 60000))
        throw new Error('Shoot reconciliation is overdue')
    return true
}
class HealthReporter {
    constructor(databasePath, snapshot, logger = console) {
        this.filename = healthPath(databasePath)
        this.snapshot = snapshot
        this.logger = logger
        this.queue = Promise.resolve()
    }
    write() {
        const value = { ...this.snapshot(), at: Date.now() }
        this.queue = this.queue
            .catch(() => {})
            .then(async () => {
                const temporary = `${this.filename}.${process.pid}.tmp`
                await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
                await fs.rename(temporary, this.filename)
            })
        return this.queue
    }
    async start() {
        await this.write()
        this.timer = setInterval(
            () => this.write().catch((error) => this.logger.error('[TVM] Health write failed:', error.message)),
            15000
        ).unref()
    }
    async stop() {
        clearInterval(this.timer)
        await this.write()
    }
}
module.exports = { HealthReporter, healthPath, checkHealth }
