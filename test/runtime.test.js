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
    const client = new EventEmitter()
    client.login = async () => {
        closed.push('login')
    }
    client.destroy = () => {
        closed.push('client')
    }
    client.channels = { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) }
    const shoots = {
        async handleInteraction() {
            return false
        },
        stop() {
            closed.push('shoots')
        },
        async drain() {}
    }
    const unverifiedRoles = {
        async syncGuild() {
            return { added: 0, removed: 0, failed: 0 }
        }
    }
    const app = createApp({
        config: { guildId, adminRoleId: adminId },
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
