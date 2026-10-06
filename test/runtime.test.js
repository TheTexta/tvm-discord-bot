// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js')
const { createApp } = require('../src/tvm/App')
const Store = require('../src/tvm/Store')
const { prepareClient, config: runtimeConfig } = require('./helpers/runtime')

const guildId = '100000000000000001'
const userId = '100000000000000002'
const adminId = '100000000000000003'
const logger = { error() {}, log() {} }
const deferred = () => {
    let resolve
    const promise = new Promise((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function fixture({ store = { async close() {} }, mail = { async sendMail() {}, close() {} }, timeout = 1000 } = {}) {
    const closed = []
    const { client, rest } = prepareClient(new EventEmitter())
    client.login = async () => {
        client.emit('clientReady')
    }
    client.destroy = () => {
        closed.push('client')
    }
    store.sweep ||= async () => {}
    store.activeClaims ||= async () => []
    const shoots = {
        async initialize() {},
        async handleInteraction() {
            return false
        },
        stop() {
            closed.push('shoots')
        },
        async drain() {}
    }
    const unverifiedRoles = {
        async initialize() {
            return { id: 'unverified' }
        },
        async syncGuild() {
            return { added: 0, removed: 0, failed: 0 }
        }
    }
    const app = createApp({
        config: { ...runtimeConfig, adminRoleId: adminId },
        rest,
        store,
        mail,
        client,
        shoots,
        unverifiedRoles,
        logger,
        shutdownTimeoutMs: timeout
    })
    function interaction(commandName, email = 'member@example.org') {
        return {
            commandName,
            guildId,
            user: { id: userId },
            guild: {},
            memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
            member: { roles: [] },
            fields: { getTextInputValue: () => email },
            options: { getString: () => email, getSubcommand: () => 'reconcile' },
            replies: [],
            isButton: () => false,
            isModalSubmit: () => commandName === null,
            isChatInputCommand: () => commandName !== null,
            customId: 'tvm:email',
            async reply(payload) {
                this.replied = true
                this.replies.push(payload)
            },
            async deferReply() {
                this.deferred = true
            },
            async editReply(payload) {
                this.replies.push(payload)
            }
        }
    }
    return { app, client, closed, interaction, handle: client.listeners('interactionCreate')[0] }
}

test('importing runtime modules needs no environment, database, or Discord connection', () => {
    const result = spawnSync(process.execPath, ['-e', "require('./src/tvm/App'); require('./src/tvm/index')"], {
        cwd: path.join(__dirname, '..'),
        env: {},
        encoding: 'utf8',
        timeout: 5000
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    const f = fixture()
    assert.deepEqual(f.closed, [])
    return f.app.shutdown()
})

test('shutdown stops incoming work, waits for accepted delivery, and closes resources once in order', async () => {
    const sending = deferred(),
        delivered = deferred()
    const order = []
    const f = fixture({
        mail: {
            async sendMail() {
                sending.resolve()
                await delivered.promise
            },
            close() {
                order.push('mail')
            }
        },
        store: {
            async close() {
                order.push('store')
            }
        }
    })
    await f.app.start()
    const request = f.handle(f.interaction('testmail'))
    await sending.promise
    const shutdown = f.app.shutdown()
    assert.equal(f.app.shutdown(), shutdown)
    assert.equal(f.client.listenerCount('interactionCreate'), 0)
    const refused = f.interaction('testmail')
    await f.handle(refused)
    assert.equal(refused.replies.length, 0)
    assert.deepEqual(order, [])
    delivered.resolve()
    await request
    await shutdown
    assert.deepEqual(order, ['mail', 'store'])
    assert.deepEqual(f.closed, ['shoots', 'client'])
})

test('shutdown has a deadline when an external operation does not finish', async () => {
    const sending = deferred(),
        delivered = deferred()
    const f = fixture({
        timeout: 20,
        mail: {
            async sendMail() {
                sending.resolve()
                await delivered.promise
            },
            close() {}
        }
    })
    await f.app.start()
    const request = f.handle(f.interaction('testmail'))
    await sending.promise
    await assert.rejects(f.app.shutdown(), /Shutdown exceeded/)
    assert.ok(f.closed.includes('client'))
    delivered.resolve()
    await request
})

test(
    'slow verification delivery allows reconciliation and never revives codes invalidated by a roster change',
    { timeout: 2000 },
    async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-runtime-'))
        const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
        const sending = deferred(),
            delivered = deferred()
        const f = fixture({
            store,
            mail: {
                async sendMail() {
                    sending.resolve()
                    await delivered.promise
                },
                close() {}
            }
        })
        t.after(async () => {
            delivered.resolve()
            await f.app.shutdown()
            fs.rmSync(dir, { recursive: true, force: true })
        })
        await store.mergeRoster(guildId, [{ email: 'member@example.org', role: 'gm' }], adminId)
        await f.app.start()
        const request = f.handle(f.interaction(null))
        await sending.promise
        assert.equal((await store.pendingFor(guildId, userId)).email, 'member@example.org')
        const reconcile = f.interaction('roster')
        await f.handle(reconcile)
        assert.ok(reconcile.replies.length)
        await store.mergeRoster(guildId, [{ email: 'member@example.org', role: 'exec' }], adminId)
        assert.equal(await store.pendingFor(guildId, userId), undefined)
        delivered.resolve()
        await request
        assert.equal(await store.pendingFor(guildId, userId), undefined)
    }
)

function startupFixture({ ready, initialize, role = {}, loginError } = {}) {
    const { client, guild, config, rest } = prepareClient()
    const events = []
    const store = {
        ready,
        async sweep() {
            events.push('sweep')
        },
        async activeClaims() {
            return []
        },
        async close() {
            events.push('close')
        }
    }
    guild.roles.fetch = async (id) => ({ id, position: 1, managed: false, ...role })
    const unverifiedRoles = {
        async initialize() {
            events.push('unverified')
            return { id: 'unverified' }
        },
        async syncGuild() {
            return { added: 0, removed: 0, failed: 0 }
        }
    }
    const shoots = {
        async initialize() {
            events.push('shoots')
            await initialize?.()
        },
        async handleInteraction() {
            throw new Error('startup must gate interactions')
        },
        stop() {},
        async drain() {}
    }
    if (loginError)
        client.login = async () => {
            throw loginError
        }
    const app = createApp({ config, client, rest, store, shoots, unverifiedRoles, mail: {}, logger })
    function interaction(commandName) {
        return {
            guildId: config.guildId,
            commandName,
            isChatInputCommand: () => true,
            replies: [],
            async reply(payload) {
                this.replies.push(payload)
            }
        }
    }
    return { app, client, events, interaction, handle: client.listeners('interactionCreate')[0] }
}

test('startup gates interactions, keeps source available, and resolves only after initialization', async (t) => {
    const waiting = deferred()
    const f = startupFixture({ initialize: () => waiting.promise })
    t.after(() => f.app.shutdown())
    const start = f.app.start()
    assert.equal(f.app.start(), start)
    let ready = false
    start.then(() => {
        ready = true
    })
    const verify = f.interaction('verify')
    await f.handle(verify)
    assert.match(verify.replies[0].content, /starting up/)
    assert.equal(verify.replies[0].flags, 64)
    const source = f.interaction('source')
    await f.handle(source)
    assert.match(source.replies[0].content, /tvm-discord-bot/)
    assert.equal(ready, false)
    waiting.resolve()
    await start
    assert.equal(ready, true)
    assert.deepEqual(f.events, ['sweep', 'unverified', 'shoots'])
})

test('initialization and login failures reject start rather than reporting readiness', async (t) => {
    for (const options of [
        { role: { managed: true } },
        { role: { id: runtimeConfig.guildId } },
        { loginError: new Error('login failed') }
    ]) {
        const f = startupFixture(options)
        t.after(() => f.app.shutdown())
        await assert.rejects(f.app.start(), /cannot manage|login failed/)
        assert.equal(f.events.includes('shoots'), false)
    }
})

test('shutdown during initialization rejects start and drains without starting later services', async () => {
    const waiting = deferred()
    const f = startupFixture({ ready: waiting.promise })
    const start = f.app.start()
    const rejected = assert.rejects(start, /stopping/)
    await new Promise((resolve) => setImmediate(resolve))
    const stop = f.app.shutdown()
    waiting.resolve()
    await rejected
    await stop
    assert.deepEqual(f.events, ['close'])
    await assert.rejects(f.app.start(), /stopping/)
})
