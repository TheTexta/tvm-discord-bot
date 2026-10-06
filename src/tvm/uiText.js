// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

// Named placeholders keep editable wording separate from application values.
function createTextRenderer(text) {
    return function uiText(key, values = {}) {
        const template = key.split('.').reduce((value, part) => value?.[part], text)
        if (typeof template !== 'string') throw new Error(`Missing UI text: ${key}`)
        return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, name) => {
            if (!Object.hasOwn(values, name)) throw new Error(`Missing UI text value: ${key}.${name}`)
            return String(values[name])
        })
    }
}

const text = require('../../ui-text.json')
const schema = require('./uiTextSchema.json')

const shootLimits = {
    command: 100,
    setup: 100,
    edit: 100,
    crew: 100,
    add: 100,
    close: 100,
    reopen: 100,
    membersOption: 100,
    addUserOption: 100,
    setupTitle: 45,
    editTitle: 45,
    nameLabel: 45,
    dateLabel: 45,
    timeLabel: 45,
    locationLabel: 45,
    joinLabel: 45,
    joinDescription: 100,
    joinDay: 100,
    joinTwoDays: 100,
    joinWeek: 100,
    joinMonth: 100,
    joinNever: 100
}

function validateUiText(candidate = text) {
    for (const [key, required] of Object.entries(schema)) {
        const template = key.split('.').reduce((value, part) => value?.[part], candidate)
        if (typeof template !== 'string' || !template.trim()) throw new Error(`Missing UI text: ${key}`)
        const actual = [
            ...new Set([...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]))
        ].sort()
        if (JSON.stringify(actual) !== JSON.stringify(required))
            throw new Error(`Invalid UI text placeholders: ${key}; expected ${required.join(', ') || 'none'}`)
        const limit = key.startsWith('commands.')
            ? 100
            : key.startsWith('buttons.')
              ? 80
              : key.startsWith('modals.')
                ? 45
                : key.startsWith('shoot.')
                  ? shootLimits[key.slice(6)]
                  : null
        if (limit && template.length > limit) throw new Error(`UI text exceeds ${limit} characters: ${key}`)
    }
    return candidate
}

const uiText = createTextRenderer(text)
module.exports = { uiText, createTextRenderer, validateUiText }
