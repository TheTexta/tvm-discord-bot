// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const normalizeEmail = (value) =>
    String(value ?? '')
        .trim()
        .toLowerCase()
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
const validSnowflake = (value) => /^\d{17,20}$/.test(value)

function required(env, name) {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
}

function boolean(env, name, fallback = false) {
    const value = env[name]?.trim()
    if (!value) return fallback
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`)
    return value === 'true'
}

module.exports = { normalizeEmail, validEmail, validSnowflake, required, boolean }
