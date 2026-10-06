// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { HealthReporter, healthPath, checkHealth } = require('../src/infrastructure/HealthReporter')

test('health requires fresh heartbeat, Discord connection, and successful reconciliation timestamps', () => {
    const now = 100000000
    const value = {
        at: now,
        state: 'ready',
        connected: true,
        membershipLastSuccessAt: now,
        shootsEnabled: true,
        shootLastSuccessAt: now
    }
    assert.equal(checkHealth(value, now), true)
    for (const patch of [
        { at: now - 60000 },
        { at: now + 1 },
        { connected: false },
        { state: 'stopping' },
        { membershipLastSuccessAt: now - 2 * 3600000 },
        { shootLastSuccessAt: now - 5 * 60000 },
        { membershipLastSuccessAt: null }
    ])
        assert.throws(() => checkHealth({ ...value, ...patch }, now))
    assert.equal(checkHealth({ ...value, shootsEnabled: false, shootLastSuccessAt: null }, now), true)
})

test('health reporter writes privately, serializes updates, and marks shutdown without member data', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-health-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    let state = 'ready'
    const reporter = new HealthReporter(path.join(dir, 'test.db'), () => ({
        state,
        connected: state === 'ready',
        membershipLastSuccessAt: Date.now(),
        shootsEnabled: false
    }))
    await reporter.start()
    assert.equal((await fs.stat(reporter.filename)).mode & 0o777, 0o600)
    assert.equal(checkHealth(JSON.parse(await fs.readFile(healthPath(path.join(dir, 'test.db')), 'utf8'))), true)
    await Promise.all([reporter.write(), reporter.write()])
    state = 'stopping'
    await reporter.stop()
    const data = JSON.parse(await fs.readFile(reporter.filename, 'utf8'))
    assert.equal(data.connected, false)
    assert.equal(data.state, 'stopping')
    assert.doesNotMatch(JSON.stringify(data), /email|userId|token|secret/)
})
