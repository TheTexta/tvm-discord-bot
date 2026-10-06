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

const uiText = createTextRenderer(require('../../ui-text.json'))
module.exports = { uiText, createTextRenderer }
