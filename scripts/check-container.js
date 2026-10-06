// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../src/tvm/Store')
const { createApp } = require('../src/tvm/App')
require('../src/tvm/index') // Importing either module must not start the bot.

async function main() {
    assert.notEqual(process.getuid?.(), 0, 'The runtime must run as a non-root user')
    assert.equal(typeof createApp, 'function')
    fs.accessSync(process.argv[2] || '/usr/app/config', fs.constants.W_OK)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-container-'))
    const filename = path.join(dir, 'smoke.db')
    const store = new Store(filename, 'smoke-test-secret'.repeat(3))
    try {
        await store.ready
        await store.mergeRoster('100000000000000001', [{ email: 'smoke@example.org', role: 'gm' }], 'smoke-test')
        assert.equal((await store.status('100000000000000001')).count, 1)
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
        assert.deepEqual(await store.rosterEntries('100000000000000001'), [{ email: 'smoke@example.org', role: 'gm' }])
        console.log(
            'Container smoke check passed: non-root runtime, native SQLite, migrations, and writable data directory'
        )
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

main().catch((error) => {
    console.error(`Container smoke check failed: ${error.message}`)
    process.exitCode = 1
})
