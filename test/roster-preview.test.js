// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PermissionsBitField } = require('discord.js')
const Store = require('../src/infrastructure/Store')
const { createRosterCommands } = require('../src/membership/RosterCommands')
const { AdminOperationError } = require('../src/shared/AdminOperation')

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-preview-'))
    const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
    t.after(async () => {
        await store.close()
        await fs.rm(dir, { recursive: true, force: true })
    })
    const originalFetch = global.fetch
    global.fetch = async () => ({
        ok: true,
        text: async () => 'Email,Role\nkeep@example.org,GM\nnew@example.org,Admin\n'
    })
    t.after(() => {
        global.fetch = originalFetch
    })
    await store.replaceRoster(
        'guild',
        [
            { email: 'keep@example.org', role: 'exec' },
            { email: 'omit@example.org', role: 'gm' }
        ],
        'admin'
    )
    await store.savePending('guild', 'member', 'keep@example.org', '123456')
    let clock = 1000000,
        reconciliations = 0,
        queue = Promise.resolve()
    const commands = createRosterCommands({
        config: { guildId: 'guild', adminRoleId: 'admin-role' },
        store,
        membership: {},
        unverifiedRoles: {},
        alertAdmins: async () => {},
        withMembershipLock: (work) => {
            const next = queue.then(work)
            queue = next.catch(() => {})
            return next
        },
        scheduleReconciliation: async () => {
            reconciliations++
        },
        privateReply: async (interaction, content, components = []) => {
            await interaction.editReply({ content, components })
        },
        now: () => clock
    })
    const interaction = (customId) => ({
        guildId: 'guild',
        channelId: 'channel',
        guild: {},
        user: { id: 'admin' },
        member: { roles: ['admin-role'] },
        memberPermissions: new PermissionsBitField(0n),
        customId,
        replies: [],
        options: { getAttachment: () => ({ url: 'https://example.invalid/roster.csv', size: 100 }) },
        async deferReply() {
            this.deferred = true
        },
        async reply(payload) {
            this.replies.push(payload)
        },
        async editReply(payload) {
            this.replies.push(payload)
        }
    })
    async function preview() {
        const request = interaction()
        await commands.uploadRoster(request)
        const button = request.replies[0].components[0].toJSON().components[0]
        return { request, click: interaction(button.custom_id), button }
    }
    return {
        store,
        commands,
        interaction,
        preview,
        advance: (ms) => {
            clock += ms
        },
        reconciliations: () => reconciliations
    }
}

test('upload previews omissions and demotions without mutating roster, codes, metadata or audit', async (t) => {
    const f = await fixture(t)
    const before = await f.store.status('guild'),
        audit = await f.store.audit('guild')
    const { request, click, button } = await f.preview()
    assert.match(request.replies[0].content, /omitted: 1; tier changes: 1, including 1 demotions/)
    assert.equal(button.style, 4)
    assert.equal(JSON.stringify(request.replies).includes('@example.org'), false)
    assert.deepEqual(await f.store.status('guild'), before)
    assert.deepEqual(await f.store.audit('guild'), audit)
    assert.ok(await f.store.pendingFor('guild', 'member'))
    assert.equal(f.reconciliations(), 0)
    await f.commands.handleUploadButton(click)
    assert.match(click.replies[0].content, /Accepted roster snapshot v2/)
    assert.equal((await f.store.status('guild')).meta.authoritative, 1)
    assert.equal(await f.store.lookup('guild', 'omit@example.org'), undefined)
    assert.equal(await f.store.pendingFor('guild', 'member'), undefined)
    assert.equal(f.reconciliations(), 1)
    await assert.rejects(f.commands.handleUploadButton(click), /expired|already used/)
})

test('previews bind admin, channel, guild and current authority; invalid clicks cannot consume them', async (t) => {
    const f = await fixture(t)
    const { click } = await f.preview()
    for (const changed of [{ user: { id: 'other' } }, { channelId: 'other' }, { guildId: 'other' }])
        await assert.rejects(f.commands.handleUploadButton({ ...click, ...changed }), /expired|another admin/)
    const denied = { ...click, member: { roles: [] }, replies: [] }
    await f.commands.handleUploadButton(denied)
    assert.match(denied.replies[0].content, /Admin Team role/)
    assert.equal(denied.deferred, undefined)
    await f.commands.handleUploadButton(click)
    assert.equal((await f.store.status('guild')).meta.version, 2)
})

test('cancellation, expiry, newer previews and restart discard data without applying it', async (t) => {
    const f = await fixture(t)
    const cancelled = await f.preview()
    cancelled.click.customId = cancelled.click.customId.replace(':confirm:', ':cancel:')
    await f.commands.handleUploadButton(cancelled.click)
    assert.match(cancelled.click.replies[0].content, /cancelled/)
    await assert.rejects(f.commands.handleUploadButton(cancelled.click), /expired/)
    const expired = await f.preview()
    f.advance(10 * 60000)
    await assert.rejects(f.commands.handleUploadButton(expired.click), /expired/)
    const old = await f.preview()
    await f.preview()
    await assert.rejects(f.commands.handleUploadButton(old.click), /expired/)
    const restarted = await f.preview()
    f.commands.stop()
    await assert.rejects(f.commands.handleUploadButton(restarted.click), /expired/)
    assert.equal((await f.store.status('guild')).meta.version, 1)
})

test('stale and concurrent confirmations cannot overwrite an intervening snapshot', async (t) => {
    const f = await fixture(t)
    const stale = await f.preview()
    await f.store.replaceRoster('guild', [{ email: 'current@example.org', role: 'gm' }], 'another-admin')
    await assert.rejects(f.commands.handleUploadButton(stale.click), /roster changed/)
    assert.ok(await f.store.lookup('guild', 'current@example.org'))
    const { click } = await f.preview()
    const results = await Promise.allSettled([
        f.commands.handleUploadButton(click),
        f.commands.handleUploadButton({ ...click })
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal((await f.store.status('guild')).meta.version, 3)
    assert.equal(f.reconciliations(), 1)
})

test('accepted replacement survives a lost confirmation, and its token cannot apply twice', async (t) => {
    const f = await fixture(t)
    const { click } = await f.preview()
    click.editReply = async () => {
        throw new Error('confirmation unavailable')
    }
    await assert.rejects(f.commands.handleUploadButton(click), (error) => {
        assert.ok(error instanceof AdminOperationError)
        assert.match(error.message, /action was accepted.*confirmation could not be delivered/)
        assert.match(error.message, /Accepted roster snapshot v2/)
        return true
    })
    assert.equal((await f.store.status('guild')).meta.version, 2)
    assert.equal(f.reconciliations(), 1)
    await assert.rejects(f.commands.handleUploadButton(click), /expired/)
})

test('expected-version check is enforced atomically by the repository and preserves pending codes', async (t) => {
    const f = await fixture(t)
    const before = await f.store.audit('guild')
    await assert.rejects(
        f.store.replaceRoster('guild', [{ email: 'wrong@example.org', role: 'gm' }], 'admin', { expectedVersion: 0 }),
        /roster changed/
    )
    assert.ok(await f.store.pendingFor('guild', 'member'))
    assert.deepEqual(await f.store.audit('guild'), before)
})
