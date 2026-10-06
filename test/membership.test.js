// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../src/tvm/Store')
const { createMembershipService } = require('../src/tvm/MembershipService')
const { createRosterCommands } = require('../src/tvm/RosterCommands')
const { createVerificationService } = require('../src/tvm/VerificationService')

async function fixture(t, { role = 'exec', external = false, failRemoval = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-membership-'))
    const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
    t.after(async () => {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const config = {
        guildId: 'guild',
        memberRoleId: 'gm',
        execRoleId: 'exec',
        adminRoleId: 'admin',
        autoRoleRevocation: true
    }
    const live = new Map([
        ['old', new Set(role === 'exec' ? ['gm', 'exec'] : ['gm'])],
        ['target', new Set()]
    ])
    const removals = [],
        fetches = []
    const member = (id, stale = false) => ({
        id,
        roles: {
            cache: new Map([...(stale ? [] : live.get(id))].map((role) => [role, {}])),
            async remove(role) {
                removals.push([id, role])
                if (role === failRemoval) throw new Error('Discord role removal failed')
                live.get(id).delete(role)
                return member(id)
            },
            async add(role) {
                live.get(id).add(role)
                return member(id)
            }
        }
    })
    const guild = {
        members: {
            fetch: async (options) => {
                fetches.push(options)
                return typeof options === 'string' ? member(options, true) : member(options.user)
            }
        }
    }
    const unverifiedRoles = {
        async syncMember() {},
        async syncGuild() {
            return { added: 0, removed: 0, failed: 0 }
        }
    }
    const membership = createMembershipService({ config, store, unverifiedRoles, alertAdmins: async () => {} })
    const commands = createRosterCommands({
        config,
        store,
        membership,
        unverifiedRoles,
        withMembershipLock: (work) => work(),
        privateReply: async () => {},
        alertAdmins: async () => {}
    })
    await store.mergeRoster('guild', [{ email: 'old@example.org', role }], 'admin')
    await store.savePending('guild', 'old', 'old@example.org', '123456')
    await store.verifyAndClaim('guild', 'old', '123456', external ? { member: true, exec: true } : {})
    const interaction = (action) => ({
        user: { id: 'admin' },
        guild,
        async deferReply() {},
        options: { getSubcommand: () => action, getString: () => 'old@example.org', getUser: () => ({ id: 'target' }) }
    })
    return { store, config, live, removals, fetches, guild, membership, commands, interaction }
}

test('release bypasses stale caches and removes managed roles before deleting the claim', async (t) => {
    const f = await fixture(t)
    await f.commands.handleRoster(f.interaction('release'))
    assert.equal(await f.store.claimFor('guild', 'old@example.org'), undefined)
    assert.deepEqual([...f.live.get('old')], [])
    assert.ok(f.fetches.every((options) => options.force === true))
})

test('release preserves roles that existed before verification', async (t) => {
    const f = await fixture(t, { external: true })
    await f.commands.handleRoster(f.interaction('release'))
    assert.deepEqual([...f.live.get('old')], ['gm', 'exec'])
    assert.deepEqual(f.removals, [])
    assert.equal(await f.store.claimFor('guild', 'old@example.org'), undefined)
})

test('partial release failure retains the claim and role ownership for retry', async (t) => {
    const f = await fixture(t, { failRemoval: 'exec' })
    await assert.rejects(f.commands.handleRoster(f.interaction('release')), /removal failed/)
    const claim = await f.store.claimFor('guild', 'old@example.org')
    assert.equal(claim.user_id, 'old')
    assert.equal(claim.managed_role, 1)
    assert.equal(claim.managed_exec_role, 1)
    assert.deepEqual([...f.live.get('old')], ['exec'])
})

test('transfer rejects an already claimed target before changing Discord roles', async (t) => {
    const f = await fixture(t)
    await f.store.mergeRoster('guild', [{ email: 'target@example.org', role: 'gm' }], 'admin')
    await f.store.savePending('guild', 'target', 'target@example.org', '123456')
    await f.store.verifyAndClaim('guild', 'target', '123456')
    await assert.rejects(f.commands.handleRoster(f.interaction('transfer')), /already linked/i)
    assert.deepEqual(f.removals, [])
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).user_id, 'old')
})

test('partial transfer failure restores the old roles and retains the original claim', async (t) => {
    const f = await fixture(t, { failRemoval: 'exec' })
    await assert.rejects(f.commands.handleRoster(f.interaction('transfer')), /removal failed/)
    assert.deepEqual([...f.live.get('old')].sort(), ['exec', 'gm'])
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).user_id, 'old')
    assert.deepEqual([...f.live.get('target')], [])
})

test('reconciliation refreshes removed claims before revoking roles', async (t) => {
    const f = await fixture(t)
    await f.store.replaceRoster('guild', [{ email: 'other@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')], [])
    assert.equal(await f.store.claimFor('guild', 'old@example.org'), undefined)
    assert.ok(f.fetches.every((options) => options.force === true))
})

test('verification refreshes roles before recording ownership of an external role', async (t) => {
    const f = await fixture(t, { role: 'gm', external: true })
    await f.store.releaseClaim('guild', 'old@example.org', 'admin')
    await f.store.savePending('guild', 'old', 'old@example.org', '123456')
    const verification = createVerificationService({
        config: f.config,
        store: f.store,
        membership: f.membership,
        mail: {},
        withMembershipLock: (work) => work(),
        privateReply: async () => {},
        alertAdmins: async () => {},
        logger: console
    })
    await verification.checkCode({
        guild: f.guild,
        user: { id: 'old' },
        async deferReply() {},
        fields: { getTextInputValue: () => '123456' }
    })
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).managed_role, 0)
    assert.ok(f.fetches.every((options) => options.force === true))
})
