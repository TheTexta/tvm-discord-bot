// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../src/infrastructure/Store')
const { spawnSync } = require('node:child_process')
const { HealthReporter } = require('../src/infrastructure/HealthReporter')
const { createApp } = require('../src/app/App')
require('../src/app/index') // Importing either module must not start the bot.

async function main() {
    assert.notEqual(process.getuid?.(), 0, 'The runtime must run as a non-root user')
    assert.equal(typeof createApp, 'function')
    fs.accessSync(process.argv[2] || '/usr/app/config', fs.constants.W_OK)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-container-'))
    const filename = path.join(dir, 'smoke.db')
    const store = new Store(filename, 'smoke-test-secret'.repeat(3))
    let state = 'ready'
    const health = new HealthReporter(filename, () => ({
        state,
        connected: state === 'ready',
        membershipLastSuccessAt: Date.now(),
        shootsEnabled: false
    }))
    try {
        await store.ready
        await store.replaceRoster('100000000000000001', [{ email: 'smoke@example.org', role: 'gm' }], 'smoke-test')
        assert.equal((await store.status('100000000000000001')).count, 1)
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
        assert.deepEqual(await store.rosterEntries('100000000000000001'), [{ email: 'smoke@example.org', role: 'gm' }])
        assert.equal((await store.status('100000000000000001')).meta.authoritative, 1)
        await health.start()
        const result = spawnSync(process.execPath, [path.join(__dirname, 'check-health.js')], {
            env: { ...process.env, TVM_DATABASE_PATH: filename },
            encoding: 'utf8'
        })
        assert.equal(result.status, 0, result.stderr)
        console.log(
            'Container smoke check passed: non-root runtime, native SQLite, snapshot migration, healthcheck, and writable data directory'
        )
    } finally {
        state = 'stopping'
        await health.stop()
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

main().catch((error) => {
    console.error(`Container smoke check failed: ${error.message}`)
    process.exitCode = 1
})
