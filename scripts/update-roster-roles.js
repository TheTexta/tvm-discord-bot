// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const { parseRoster } = require('../src/tvm/roster')
const Store = require('../src/tvm/Store')
const { loadRosterConfig } = require('../src/tvm/config')

const filename = process.argv[2]
const expectedCount = Number(process.argv[3])
if (!filename || !Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
    console.error('Usage: node scripts/update-roster-roles.js /path/to/roster.csv EXPECTED_COUNT')
    process.exit(2)
}

async function main() {
    const rows = parseRoster(fs.readFileSync(filename, 'utf8'))
    if (rows.length !== expectedCount) throw new Error('Roster row count differs from expected count')
    const { guildId, codeSecret, databasePath } = loadRosterConfig()
    const store = new Store(databasePath, codeSecret)
    try {
        const current = await store.rosterEntries(guildId)
        const existing = new Set(current.map((row) => row.email))
        if (existing.size !== expectedCount || rows.some((row) => !existing.has(row.email))) {
            throw new Error('Candidate emails differ from the active roster; no changes made')
        }
        const result = await store.replaceRoster(guildId, rows, 'system:role-migration')
        console.log(`Roster roles updated: ${result.count} entries, version ${result.version}`)
    } finally {
        await store.close()
    }
}

main().catch((error) => {
    console.error(`Roster role update failed: ${error.message}`)
    process.exitCode = 1
})
