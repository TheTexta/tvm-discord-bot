// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdminAlerter } = require('../src/infrastructure/AdminAlerts')

test('admin alerts coalesce concurrent sends, deduplicate delivered messages, and expire the cooldown', async () => {
    let now = 0,
        sends = 0
    const alert = createAdminAlerter({
        isReady: () => true,
        now: () => now,
        send: async () => {
            sends++
            return true
        }
    })
    assert.deepEqual(await Promise.all([alert('failure'), alert('failure')]), [true, true])
    assert.equal(await alert('failure'), true)
    assert.equal(sends, 1)
    now = 5 * 60000
    assert.equal(await alert('failure'), true)
    assert.equal(sends, 2)
})

test('unavailable and failed alert delivery do not start a cooldown or leak transport errors', async () => {
    let ready = false,
        sends = 0
    const logs = []
    const alert = createAdminAlerter({
        isReady: () => ready,
        logger: { error: (...args) => logs.push(args) },
        send: async () => {
            if (++sends === 1) throw new Error('https://discord.com/api/webhooks/private-token secret-body')
            return true
        }
    })
    assert.equal(await alert('failure'), false)
    ready = true
    assert.equal(await alert('failure'), false)
    assert.equal(await alert('failure'), true)
    assert.equal(sends, 2)
    assert.doesNotMatch(JSON.stringify(logs), /private-token|secret-body/)
})
