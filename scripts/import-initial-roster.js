// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const { parseRoster } = require('../src/tvm/roster')
const Store = require('../src/tvm/Store')

const filename = process.argv[2]
const expectedCount = Number(process.argv[3])
if (!filename || !Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
    console.error('Usage: node scripts/import-initial-roster.js /path/to/emails.csv EXPECTED_COUNT')
    process.exit(2)
}

async function main() {
    const rows = parseRoster(fs.readFileSync(filename, 'utf8'))
    if (rows.length !== expectedCount) throw new Error('Roster row count differs from expected count')
    const guildId = process.env.TVM_GUILD_ID
    const secret = process.env.VERIFICATION_CODE_SECRET
    if (!guildId || !secret) throw new Error('Missing guild ID or verification code secret')
    const store = new Store(process.env.TVM_DATABASE_PATH || '/usr/app/config/tvm.db', secret)
    try {
        const status = await store.status(guildId)
        if (status.meta) throw new Error('An active roster already exists; use /roster replace')
        const result = await store.replaceRoster(guildId, rows, 'system:initial-import')
        console.log(`Initial email roster imported: ${result.count} entries, version ${result.version}`)
    } finally {
        await store.close()
    }
}

main().catch(error => {
    console.error(`Initial roster import failed: ${error.message}`)
    process.exitCode = 1
})
