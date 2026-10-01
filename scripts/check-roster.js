// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const fs = require('node:fs')
const { parse } = require('csv-parse/sync')

const filename = process.argv[2]
if (!filename) {
    console.error('Usage: npm run roster:check -- /path/to/eligible-members.csv')
    process.exit(2)
}

try {
    const csv = fs.readFileSync(filename, 'utf8')
    if (Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) throw new Error('CSV exceeds 2 MiB')
    const records = parse(csv, { bom: true, skip_empty_lines: true, trim: true })
    const headers = (records.shift() || []).map(value => value.trim())
    if (!headers.includes('Student ID') || !headers.includes('Email')) throw new Error('CSV needs Student ID and Email headers')
    if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate headers')
    const idColumn = headers.indexOf('Student ID')
    const emailColumn = headers.indexOf('Email')
    const seenIds = new Map()
    const seenEmails = new Map()
    const issues = []
    if (!records.length) issues.push('Roster is empty')
    if (records.length > 10000) issues.push('Roster exceeds 10,000 rows')
    for (const [index, record] of records.entries()) {
        const row = index + 2
        if (record.length !== headers.length) issues.push(`Row ${row}: column count differs from header`)
        const id = String(record[idColumn] || '').trim()
        const email = String(record[emailColumn] || '').trim().toLowerCase()
        if (!/^\d{1,32}$/.test(id)) issues.push(`Row ${row}: missing or invalid Student ID`)
        else if (seenIds.has(id)) issues.push(`Rows ${seenIds.get(id)} and ${row}: duplicate Student ID`)
        else seenIds.set(id, row)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push(`Row ${row}: missing or invalid Email`)
        else if (seenEmails.has(email)) issues.push(`Rows ${seenEmails.get(email)} and ${row}: duplicate Email`)
        else seenEmails.set(email, row)
    }
    console.log(`${records.length} roster records checked; ${issues.length} issue(s).`)
    for (const issue of issues) console.log(issue)
    if (issues.length) process.exitCode = 1
} catch (error) {
    console.error(`Roster check failed: ${error.message}`)
    process.exitCode = 1
}
