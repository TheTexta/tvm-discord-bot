// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createVerificationService } = require('../src/membership/VerificationService')

function fixture({ listed = true, mail, lookupError = false, reserved = true } = {}) {
    const events = [],
        replies = [],
        alerts = [],
        logs = []
    const store = {
        async status() {
            return { meta: { version: 1 }, count: 1 }
        },
        async allowRequest() {
            return true
        },
        async lookup() {
            events.push('lookup')
            assert.ok(replies.length > 0, 'eligibility must not influence acknowledgement')
            if (lookupError) throw new Error('private-member@example.org')
            return listed ? { email: 'member@example.org' } : null
        },
        async reserveSend() {
            return reserved
        },
        async savePending() {
            events.push('save')
        }
    }
    const service = createVerificationService({
        config: { guildId: 'guild' },
        store,
        membership: {},
        withMembershipLock: (work) => work(),
        privateReply: async (_interaction, content, components) => {
            replies.push({ content, components })
            events.push('reply')
        },
        mail: mail || {
            async sendMail() {
                events.push('smtp')
            }
        },
        alertAdmins: async (content) => alerts.push(content),
        logger: { error: (...args) => logs.push(args) }
    })
    const interaction = {
        user: { id: 'user' },
        fields: { getTextInputValue: () => 'member@example.org' },
        async deferReply() {}
    }
    return { service, interaction, events, replies, alerts, logs }
}

test('listed, absent, and send-limited addresses receive identical feedback before eligibility lookup', async () => {
    const results = []
    for (const options of [{}, { listed: false }, { reserved: false }]) {
        const f = fixture(options)
        await f.service.sendVerification(f.interaction)
        assert.equal(f.events[0], 'reply')
        results.push(f.replies)
    }
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(results[0], results[2])
})

test('slow SMTP and the same-account delivery queue cannot delay generic acknowledgements', async () => {
    let release, entered
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const waiting = new Promise((resolve) => {
        entered = resolve
    })
    let sends = 0
    const f = fixture({
        mail: {
            async sendMail() {
                sends++
                entered()
                await gate
            }
        }
    })
    const first = f.service.sendVerification(f.interaction)
    await waiting
    const second = f.service.sendVerification(f.interaction)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.replies.length, 2)
    release()
    await Promise.all([first, second])
    assert.equal(sends, 2)
    assert.deepEqual(f.alerts, [])
})

test('delivery and post-acknowledgement database failures never edit member feedback or expose addresses', async () => {
    for (const options of [
        { lookupError: true },
        {
            mail: {
                async sendMail() {
                    throw new Error('private-member@example.org')
                }
            }
        }
    ]) {
        const f = fixture(options)
        await f.service.sendVerification(f.interaction)
        assert.equal(f.replies.length, 1)
        assert.match(f.replies[0].content, /If this email is on/)
        assert.equal(f.alerts.length, 1)
        assert.doesNotMatch(JSON.stringify(f.logs), /private-member/)
    }
})
