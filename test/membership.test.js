// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../src/infrastructure/Store')
const { createMembershipService } = require('../src/membership/MembershipService')
const { createRosterCommands } = require('../src/membership/RosterCommands')
const { createVerificationService } = require('../src/membership/VerificationService')

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
    await store.replaceRoster('guild', [{ email: 'old@example.org', role }], 'admin')
    await store.savePending('guild', 'old', 'old@example.org', '123456')
    await store.verifyAndClaim('guild', 'old', '123456')
    if (!external) {
        await store.markRoleManaged('guild', 'old@example.org', 'old', 'member')
        if (role === 'exec') await store.markRoleManaged('guild', 'old@example.org', 'old', 'exec')
        if (role === 'admin') await store.markRoleManaged('guild', 'old@example.org', 'old', 'admin')
    }
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
    await f.store.replaceRoster(
        'guild',
        [...(await f.store.rosterEntries('guild')), { email: 'target@example.org', role: 'gm' }],
        'admin'
    )
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
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).managed_role, 0)
    assert.equal(await f.store.isAuthorizedUser('guild', 'old'), false)
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

test('snapshots demote bot-owned roles while keeping mixed external ownership, then restore returning links', async (t) => {
    const f = await fixture(t)
    // GM existed before migration, while Exec was granted by the bot.
    await f.store.clearRoleManaged('guild', 'old@example.org', 'old', 'member')
    await f.store.replaceRoster('guild', [{ email: 'old@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')], ['gm'])
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).managed_exec_role, 0)
    await f.store.replaceRoster('guild', [{ email: 'other@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')], ['gm'])
    assert.equal(await f.store.isAuthorizedUser('guild', 'old'), false)
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).user_id, 'old')
    await f.store.replaceRoster('guild', [{ email: 'old@example.org', role: 'exec' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')].sort(), ['exec', 'gm'])
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).managed_role, 0)
    assert.equal((await f.store.claimFor('guild', 'old@example.org')).managed_exec_role, 1)
})

test('all tier transitions remove only bot-owned obsolete roles regardless of the retired switch', async (t) => {
    for (const from of ['gm', 'exec', 'admin']) {
        for (const to of ['gm', 'exec', 'admin']) {
            const f = await fixture(t, { role: from })
            f.config.autoRoleRevocation = false
            // Simulate bot assignment of the fixture's Admin role.
            if (from === 'admin') f.live.get('old').add('admin')
            await f.store.replaceRoster('guild', [{ email: 'old@example.org', role: to }], 'admin')
            await f.membership.reconcile(f.guild)
            assert.deepEqual(
                [...f.live.get('old')].sort(),
                (to === 'gm' ? ['gm'] : ['gm', to]).sort(),
                `${from} to ${to}`
            )
        }
    }
})

test('failed snapshot removal retains ownership and identity for restart and retry', async (t) => {
    const f = await fixture(t, { failRemoval: 'exec' })
    await f.store.replaceRoster('guild', [{ email: 'other@example.org', role: 'gm' }], 'admin')
    const result = await f.membership.reconcile(f.guild)
    assert.equal(result.failed, 1)
    const claim = await f.store.claimFor('guild', 'old@example.org')
    assert.equal(claim.managed_role, 0)
    assert.equal(claim.managed_exec_role, 1)
    assert.equal(claim.user_id, 'old')
    assert.equal(await f.store.isAuthorizedUser('guild', 'old'), false)
})

test('legacy roster marker protects existing roles until the first authoritative upload', async (t) => {
    const f = await fixture(t)
    await f.store._locked(() => f.store._run('UPDATE email_roster_meta SET authoritative=0'))
    await f.store._locked(() => f.store._run("UPDATE email_roster SET role='gm'"))
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')].sort(), ['exec', 'gm'])
    await f.store.replaceRoster('guild', [{ email: 'old@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')], ['gm'])
})

test('unclaimed legacy members are untouched and protected higher roles survive CSV demotion', async (t) => {
    const f = await fixture(t, { external: true })
    f.live.set('legacy', new Set(['gm', 'exec', 'admin']))
    await f.store.replaceRoster('guild', [{ email: 'old@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    assert.deepEqual([...f.live.get('old')].sort(), ['exec', 'gm'])
    assert.deepEqual([...f.live.get('legacy')], ['gm', 'exec', 'admin'])
    assert.equal(f.membership.status().protected, 2)
})

test('a newer snapshot can commit between accounts and supersedes queued tier changes', async (t) => {
    const f = await fixture(t)
    let queue = Promise.resolve()
    const withLock = (work) => {
        const next = queue.then(work)
        queue = next.catch(() => {})
        return next
    }
    let release, entered
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const waiting = new Promise((resolve) => {
        entered = resolve
    })
    const fetch = f.guild.members.fetch
    f.guild.members.fetch = async (options) => {
        if (options.user === 'old') {
            entered()
            await gate
        }
        return fetch(options)
    }
    const service = createMembershipService({
        config: f.config,
        store: f.store,
        unverifiedRoles: {
            async syncMember() {},
            async syncGuild() {
                return { added: 0, removed: 0, failed: 0 }
            }
        },
        alertAdmins: async () => {},
        logger: { log() {}, error() {} },
        withMembershipLock: withLock
    })
    const scan = service.reconcile(f.guild)
    await waiting
    const update = withLock(() => f.store.replaceRoster('guild', [{ email: 'old@example.org', role: 'gm' }], 'admin'))
    release()
    await update
    await scan
    assert.deepEqual([...f.live.get('old')], ['gm'])
    assert.equal(service.status().version, (await f.store.status('guild')).meta.version)
})

test('overlapping uploads commit in arrival order and invalid uploads preserve the authoritative snapshot', async (t) => {
    const f = await fixture(t)
    let release, started
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const waiting = new Promise((resolve) => {
        started = resolve
    })
    const originalFetch = global.fetch
    t.after(() => {
        global.fetch = originalFetch
    })
    const fetched = []
    global.fetch = async (url) => {
        fetched.push(url)
        if (url === 'first') {
            started()
            await gate
        }
        return {
            ok: true,
            text: async () =>
                url === 'invalid' ? 'Email,Role\nbad@example.org,Unknown\n' : `Email,Role\n${url}@example.org,GM\n`
        }
    }
    const commands = createRosterCommands({
        config: f.config,
        store: f.store,
        membership: f.membership,
        unverifiedRoles: {},
        withMembershipLock: (work) => work(),
        privateReply: async (interaction, content) => {
            interaction.content = content
        },
        alertAdmins: async () => {},
        scheduleReconciliation: async () => {}
    })
    const upload = (url) => ({
        async deferReply() {},
        user: { id: 'admin' },
        guild: f.guild,
        options: { getAttachment: () => ({ url, size: 100 }) }
    })
    const first = upload('first'),
        second = upload('second')
    let acknowledgeFirst, acknowledgeSecond
    const firstAcknowledgement = new Promise((resolve) => {
        acknowledgeFirst = resolve
    })
    const secondAcknowledgement = new Promise((resolve) => {
        acknowledgeSecond = resolve
    })
    first.deferReply = () => firstAcknowledgement
    second.deferReply = async () => {
        acknowledgeSecond()
    }
    const one = commands.uploadRoster(first),
        two = commands.uploadRoster(second)
    await secondAcknowledgement
    assert.deepEqual(fetched, [], 'A faster Discord acknowledgement must not reorder uploads')
    acknowledgeFirst()
    await waiting
    assert.deepEqual(fetched, ['first'])
    release()
    await Promise.all([one, two])
    assert.deepEqual(await f.store.rosterEntries('guild'), [{ email: 'second@example.org', role: 'gm' }])
    assert.match(second.content, /synchronization is queued/)
    const before = await f.store.status('guild')
    await assert.rejects(commands.uploadRoster(upload('invalid')), /Role|role/)
    assert.deepEqual(await f.store.status('guild'), before)
    assert.deepEqual(await f.store.rosterEntries('guild'), [{ email: 'second@example.org', role: 'gm' }])
})

test('successful SMTP followed by a failed Discord reply never reports delivery failure', async (t) => {
    const f = await fixture(t)
    const alerts = [],
        logs = []
    const service = createVerificationService({
        config: f.config,
        store: f.store,
        membership: f.membership,
        withMembershipLock: (work) => work(),
        mail: { async sendMail() {} },
        privateReply: async () => {
            throw new Error('Discord reply expired')
        },
        alertAdmins: async (message) => alerts.push(message),
        logger: { error: (...args) => logs.push(args) }
    })
    await assert.rejects(
        service.sendVerification({
            user: { id: 'target' },
            fields: { getTextInputValue: () => 'old@example.org' },
            async deferReply() {}
        }),
        /Discord reply expired/
    )
    assert.deepEqual(alerts, [])
    assert.deepEqual(logs, [])
    assert.ok(await f.store.pendingFor('guild', 'target'))
})

test('a reopened database retries failed role removal without recreating an omitted identity', async (t) => {
    const f = await fixture(t, { failRemoval: 'exec' })
    await f.store.replaceRoster('guild', [{ email: 'other@example.org', role: 'gm' }], 'admin')
    await f.membership.reconcile(f.guild)
    const filename = f.store.db.filename
    await f.store.close()
    const reopened = new Store(filename, 's'.repeat(32))
    try {
        await reopened.ready
        f.guild.members.fetch = async (options) => {
            const id = options.user
            const member = {
                id,
                roles: {
                    cache: new Map([...f.live.get(id)].map((role) => [role, {}])),
                    async remove(role) {
                        f.live.get(id).delete(role)
                        return member
                    }
                }
            }
            return member
        }
        const service = createMembershipService({
            config: f.config,
            store: reopened,
            unverifiedRoles: {
                async syncMember() {},
                async syncGuild() {
                    return { added: 0, removed: 0, failed: 0 }
                }
            },
            alertAdmins: async () => {},
            logger: { log() {}, error() {} }
        })
        const result = await service.reconcile(f.guild)
        assert.equal(result.failed, 0)
        assert.deepEqual([...f.live.get('old')], [])
        assert.equal((await reopened.claimFor('guild', 'old@example.org')).managed_exec_role, 0)
        assert.equal((await reopened.claimFor('guild', 'old@example.org')).user_id, 'old')
        assert.equal(await reopened.isAuthorizedUser('guild', 'old'), false)
    } finally {
        await reopened.close()
    }
})
