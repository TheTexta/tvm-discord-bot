// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('./uiText')

const { parse } = require('csv-parse/sync')

function parseRoster(csv) {
    if (Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) throw new Error(uiText('errors.rosterSize'))
    let records
    try {
        records = parse(csv, {
            bom: true,
            columns: headers => {
                const normalized = headers.map(header => header.trim())
                if (new Set(normalized).size !== normalized.length) throw new Error(uiText('errors.duplicateHeaders'))
                if (!normalized.includes('Email') || !normalized.includes('Role')) throw new Error(uiText('errors.missingHeaders'))
                return normalized
            },
            skip_empty_lines: true,
            trim: true,
            relax_column_count: false
        })
    } catch (error) {
        throw new Error(uiText('errors.invalidCsv', { error: error.message }))
    }
    if (records.length === 0) throw new Error(uiText('errors.emptyRoster'))
    if (records.length > 10000) throw new Error(uiText('errors.rosterRows'))

    const emails = new Set()
    return records.map((record, index) => {
        const email = String(record.Email ?? '').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(uiText('errors.invalidEmailRow', { row: index + 2 }))
        if (emails.has(email)) throw new Error(uiText('errors.duplicateEmailRow', { row: index + 2 }))
        emails.add(email)
        const label = String(record.Role ?? '').trim().toLowerCase()
        const role = label === 'gm' ? 'gm'
            : /^exec\s*[-:]\s*(editor|producer)$/.test(label) ? 'exec'
                : label === 'admin' ? 'admin' : null
        if (!role) throw new Error(uiText('errors.invalidRoleRow', { row: index + 2 }))
        return { email, role }
    })
}

module.exports = { parseRoster }
