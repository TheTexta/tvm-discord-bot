// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { parse } = require('csv-parse/sync')

function parseRoster(csv) {
    if (Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) throw new Error('Roster exceeds 2 MiB')
    let records
    try {
        records = parse(csv, {
            bom: true,
            columns: headers => {
                const normalized = headers.map(header => header.trim())
                if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate CSV headers')
                if (!normalized.includes('Student ID') || !normalized.includes('Email')) {
                    throw new Error('CSV needs Student ID and Email headers')
                }
                return normalized
            },
            skip_empty_lines: true,
            trim: true,
            relax_column_count: false
        })
    } catch (error) {
        throw new Error(`Invalid roster CSV: ${error.message}`)
    }
    if (records.length === 0) throw new Error('Roster cannot be empty')
    if (records.length > 10000) throw new Error('Roster exceeds 10,000 rows')

    const ids = new Set()
    const emails = new Set()
    return records.map((record, index) => {
        const studentId = String(record['Student ID'] ?? '').trim()
        const email = String(record.Email ?? '').trim().toLowerCase()
        if (!/^\d{1,32}$/.test(studentId)) throw new Error(`Invalid Student ID on row ${index + 2}`)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid Email on row ${index + 2}`)
        if (ids.has(studentId)) throw new Error(`Duplicate Student ID on row ${index + 2}`)
        if (emails.has(email)) throw new Error(`Duplicate Email on row ${index + 2}`)
        ids.add(studentId)
        emails.add(email)
        return { studentId, email }
    })
}

module.exports = { parseRoster }
