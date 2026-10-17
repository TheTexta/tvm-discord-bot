// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { HTTPError } = require('discord.js')
const { ShootFailureReporter, diagnostics } = require('../src/shoots/ShootFailureReporter')
const { fixture, IDS, fields, allows } = require('./helpers/shoot')
const { PermissionFlagsBits: P } = require('discord.js')

const serverError = () =>
    new HTTPError(
        500,
        'Internal Server Error',
        'GET',
        `https://discord.com/api/v10/channels/${IDS.announce}/messages/123?secret=private-token`,
        { body: 'secret-body' }
    )
function reporterFixture() {
    let now = 0,
        delivered = true
    const logs = [],
        alerts = []
    const reporter = new ShootFailureReporter({
        now: () => now,
        logger: {
            error: (_prefix, value) => logs.push(JSON.parse(value)),
            log: (_prefix, value) => logs.push(JSON.parse(value))
        },
        alertAdmins: async (message) => {
            alerts.push(message)
            return delivered
        }
    })
    const context = {
        shootId: 'shoot-a',
        channelId: IDS.active,
        name: 'Archived test',
        status: 'closed',
        workflow: 'sync',
        trigger: 'scheduled',
        retrying: true
    }
    const fail = async (error = serverError(), extra = {}) => {
        try {
            await reporter.run({ ...context, ...extra }, () =>
                reporter.operation('fetch_brief', () => {
                    throw error
                })
            )
        } catch (caught) {
            await reporter.failure(context.shootId, caught)
        }
    }
    return {
        reporter,
        logs,
        alerts,
        context,
        fail,
        setNow: (value) => {
            now = value
        },
        setDelivered: (value) => {
            delivered = value
        }
    }
}

test('transient errors log immediately, ignore bursts during grace, and quietly recover', async () => {
    const f = reporterFixture()
    for (let i = 0; i < 20; i++) await f.fail()
    assert.equal(f.logs.length, 20)
    assert.equal(f.alerts.length, 0)
    assert.equal(f.logs[0].operation, 'fetch_brief')
    assert.equal(f.logs[0].httpStatus, 500)
    assert.equal(f.logs[0].shootStatus, 'closed')
    await f.reporter.recovered(f.context)
    assert.equal(f.alerts.length, 0)
    assert.equal(f.logs.at(-1).event, 'recovered')
    assert.equal(f.reporter.incidents.size, 0)
})

test('persistent errors alert once after grace and deliver one correlated recovery notice', async () => {
    const f = reporterFixture()
    await f.fail()
    f.setNow(119999)
    await f.fail()
    assert.equal(f.alerts.length, 0)
    f.setNow(120000)
    await f.fail()
    await f.fail()
    assert.equal(f.alerts.length, 1)
    assert.match(f.alerts[0], /Archived test.*closed.*fetch_brief.*HTTP 500/)
    assert.match(f.alerts[0], new RegExp(f.logs[0].reference))
    await f.reporter.recovered(f.context)
    await f.reporter.recovered(f.context)
    assert.equal(f.alerts.length, 2)
    assert.match(f.alerts[1], /recovered/)
})

test('permission errors alert immediately; undelivered failures and recoveries retry', async () => {
    const f = reporterFixture()
    const error = Object.assign(new Error('private-token'), { status: 403, code: 50013 })
    f.setDelivered(false)
    await f.fail(error)
    assert.equal(f.alerts.length, 1)
    f.setDelivered(true)
    await f.fail(error)
    assert.equal(f.alerts.length, 2)
    f.setDelivered(false)
    await f.reporter.recovered(f.context)
    assert.equal(f.reporter.incidents.size, 1)
    f.setDelivered(true)
    await f.reporter.recovered(f.context)
    assert.equal(f.reporter.incidents.size, 0)
    assert.equal(f.logs.filter((log) => log.event === 'recovered').length, 1)
    assert.doesNotMatch(JSON.stringify([f.alerts, f.logs]), /private-token/)
})

test('diagnostics retain safe metadata and source frames, never arbitrary messages, URLs, or bodies', () => {
    const error = serverError()
    error.stack = `Error: private-token\n    at request (/usr/app/src/shoots/ShootResources.js:10:4)\n    at https://example.org/private-token\n    at request (/usr/app/node_modules/@discordjs/rest/dist/index.js:20:5)`
    const value = diagnostics(error)
    assert.equal(value.route, '/channels/:id/messages/:id')
    assert.equal(value.method, 'GET')
    assert.deepEqual(value.stack, [
        'src/shoots/ShootResources.js:10:4',
        'node_modules/@discordjs/rest/dist/index.js:20:5'
    ])
    assert.doesNotMatch(JSON.stringify(value), /private-token|secret-body|secret=|100000000000000007/)
    error.url = 'https://discord.com/api/v10/webhooks/123/private-token'
    assert.equal(diagnostics(error).route, null)
    assert.equal(
        diagnostics(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).transient,
        true
    )
    assert.equal(
        diagnostics(Object.assign(new Error('Internal Server Error'), { code: 'private-token' })).transient,
        false
    )
    assert.equal(
        diagnostics(Object.assign(new Error('forbidden'), { status: 403, cause: { code: 'ECONNRESET' } })).transient,
        false
    )
})

test('operation context is isolated between concurrent shoots and preserves original error identity/code', async () => {
    const f = reporterFixture()
    await Promise.all(
        ['shoot-a', 'shoot-b'].map(async (shootId) => {
            const error = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })
            try {
                await f.reporter.run({ ...f.context, shootId }, async () => {
                    await Promise.resolve()
                    return f.reporter.operation(`fetch_${shootId}`, () => {
                        throw error
                    })
                })
            } catch (caught) {
                assert.equal(caught, error)
                assert.equal(caught.code, 50013)
                await f.reporter.failure(shootId, caught)
            }
        })
    )
    assert.deepEqual(f.logs.map((log) => [log.shootId, log.operation]).sort(), [
        ['shoot-a', 'fetch_shoot-a'],
        ['shoot-b', 'fetch_shoot-b']
    ])
    assert.equal(f.reporter.incidents.size, 2)
})

test('a scheduled failure recovers through the real reporter without changing resource or announcement recovery', async (t) => {
    const f = await fixture(t, { reporting: true })
    const { shoot } = await f.create()
    const fetch = f.guild.members.fetch
    f.guild.members.fetch = async () => {
        throw serverError()
    }
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 0)
    assert.equal(f.service.lastSuccessAt, null)
    assert.equal(f.logs.at(-1).operation, 'fetch_member')
    f.guild.members.fetch = fetch
    await f.service.reconcileAll()
    assert.ok(f.service.lastSuccessAt)
    assert.equal(f.logs.at(-1).event, 'recovered')
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'open')
})

test('invalid input and expired forms produce private feedback without incident alerts', async (t) => {
    const f = await fixture(t, { reporting: true })
    const invalid = f.interaction({ command: 'setup', mentions: 'not a mention' })
    await f.service.handleInteraction(invalid)
    assert.match(invalid.replies.at(-1).content, /mentions/)
    const expired = f.interaction({ customId: 'tvm:shoot:form:expired' })
    await f.service.handleInteraction(expired)
    assert.match(expired.replies.at(-1).content, /expired/)
    const invalidModal = f.interaction({ customId: 'tvm:shoot:setup:missing' })
    invalidModal.fields = fields('', '', '')
    await f.service.handleInteraction(invalidModal)
    assert.equal(f.errors.length, 0)
    assert.equal(f.logs.length, 0)
})

test('command failures distinguish before-save, pending synchronization, and failed confirmation', async (t) => {
    const f = await fixture(t, { reporting: true })
    const { shoot } = await f.create()
    const fetch = f.guild.members.fetch
    f.guild.members.fetch = async () => {
        throw serverError()
    }
    const before = f.interaction({ command: 'add', channelId: shoot.channel_id })
    await f.service.handleInteraction(before)
    assert.match(before.replies.at(-1).content, /No changes are queued/)
    assert.equal(
        (await f.store.shootParticipants(shoot.id)).some((row) => row.user_id === IDS.extra),
        false
    )
    f.guild.members.fetch = fetch
    const chat = f.channels.get(shoot.channel_id)
    chat.failEdit = true
    const after = f.interaction({ command: 'add', channelId: shoot.channel_id })
    await f.service.handleInteraction(after)
    assert.match(after.replies.at(-1).content, /changes were saved.*synchronization is pending/)
    assert.equal(
        (await f.store.shootParticipants(shoot.id)).some((row) => row.user_id === IDS.extra),
        true
    )
    await f.service.reconcileAll()
    assert.equal(allows(chat, IDS.extra, P.ViewChannel), true)
    const confirmation = f.interaction({ command: 'remove', channelId: shoot.channel_id })
    const editReply = confirmation.editReply
    let replies = 0
    confirmation.editReply = async (payload) => {
        if (++replies === 1) throw serverError()
        return editReply.call(confirmation, payload)
    }
    await f.service.handleInteraction(confirmation)
    assert.match(confirmation.replies.at(-1).content, /saved and synchronized.*confirmation/)
    assert.equal(allows(chat, IDS.extra, P.ViewChannel), false)
})

test('cosmetic cleanup failures are not falsely recovered by successful permission synchronization', async (t) => {
    const f = await fixture(t, { reporting: true })
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'outsider', true, { event: false })
    const remove = reaction.users.remove
    reaction.users.remove = async () => {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })
    }
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 1)
    assert.ok(f.service.lastSuccessAt)
    assert.equal(f.service.failures.incidents.size, 1)
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 1)
    assert.equal(
        f.logs.some((log) => log.event === 'recovered'),
        false
    )
    reaction.users.remove = remove
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 2)
    assert.match(f.errors[1], /recovered/)
})

test('deleted shoot channels alert immediately with actionable context and are not falsely recovered', async (t) => {
    const f = await fixture(t, { reporting: true })
    const { shoot } = await f.create()
    f.channels.delete(shoot.channel_id)
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 1)
    assert.match(f.errors[0], /channel is missing.*not be recreated/)
    assert.equal(f.logs.at(-1).operation, 'ensure_shoot_channel')
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 1)
    assert.equal(
        f.logs.some((log) => log.event === 'recovered'),
        false
    )
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'missing')
})

test('global reconciliation errors report once from any caller and recover on a successful scan', async (t) => {
    const f = await fixture(t, { reporting: true })
    const allShoots = f.store.allShoots.bind(f.store)
    f.store.allShoots = async () => {
        throw Object.assign(new Error('private database details'), { code: 'SQLITE_BUSY' })
    }
    await assert.rejects(f.service.reconcileAll(), /private database details/)
    assert.equal(f.errors.length, 1)
    assert.equal(f.logs.at(-1).operation, 'list_shoots')
    assert.equal(f.logs.at(-1).workflow, 'reconcile')
    f.store.allShoots = allShoots
    await f.service.reconcileAll()
    assert.equal(f.errors.length, 2)
    assert.match(f.errors[1], /recovered/)
    assert.doesNotMatch(JSON.stringify([f.errors, f.logs]), /private database details/)
})

test('failed setup after persistence stays provisioning and retries without another setup or duplicate resources', async (t) => {
    const f = await fixture(t, { reporting: true })
    f.guild.failCreateAfter = true
    const { submit, id, shoot } = await f.create()
    assert.equal(shoot.status, 'provisioning')
    assert.match(submit.replies.at(-1).content, /saved.*pending.*do not repeat setup/)
    const channels = f.channels.size
    await f.service.reconcileAll()
    assert.equal(f.channels.size, channels)
    assert.equal((await f.store.getShoot(id, IDS.guild)).status, 'open')
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.match(f.errors.at(-1), /recovered/)
})
