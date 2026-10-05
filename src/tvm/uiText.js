// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const text = require('../../ui-text.json')

// Named placeholders keep editable wording separate from application values.
function uiText(key, values = {}) {
    const template = key.split('.').reduce((value, part) => value?.[part], text)
    if (typeof template !== 'string') throw new Error(`Missing UI text: ${key}`)
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, name) => {
        if (!Object.hasOwn(values, name)) throw new Error(`Missing UI text value: ${key}.${name}`)
        return String(values[name])
    })
}

module.exports = { uiText }
