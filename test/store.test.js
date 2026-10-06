// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sqlite3 = require('sqlite3')
const Store = require('../src/tvm/Store')
const { uiText } = require('../src/tvm/uiText')

test('requires a roster email, persists codes, and binds one Discord account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const filename = path.join(dir, 'tvm.db')
    const guild = '123456789012345678'
    let store = new Store(filename, 'a'.repeat(32))
    try {
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
        assert.deepEqual(await store.status(guild), { meta: undefined, count: 0, unreconciled: 0 })
        await store.replaceRoster(
            guild,
            [
                { email: 'one@example.org', role: 'exec' },
                { email: 'two@example.org', role: 'gm' }
            ],
            'admin'
        )
        await assert.rejects(
            store.replaceRoster(
                guild,
                [
                    { email: 'three@example.org', role: 'gm' },
                    { email: 'THREE@example.org', role: 'gm' }
                ],
                'admin'
            ),
            { message: uiText('errors.rosterDuplicateEmails') }
        )
        assert.equal((await store.status(guild)).count, 2)
        assert.deepEqual(await store.lookup(guild, 'ONE@example.org'), { email: 'one@example.org', role: 'exec' })
        assert.equal(await store.lookup(guild, 'outsider@example.org'), undefined)
        await store.savePending(guild, 'user-a', 'one@example.org', '123456')
        await store.close()
        store = new Store(filename, 'a'.repeat(32))
        assert.equal((await store.pendingFor(guild, 'user-a')).email, 'one@example.org')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '000000')).reason, 'invalid')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456')).role, 'exec')
        assert.deepEqual([...(await store.activeClaimUserIds(guild))], ['user-a'])
        assert.equal(await store.isAuthorizedUser(guild, 'user-a'), true)
        assert.equal(await store.isAuthorizedUser(guild, 'user-b'), false)
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456')).reason, 'expired')
        await store.savePending(guild, 'user-b', 'one@example.org', '654321')
        assert.equal((await store.verifyAndClaim(guild, 'user-b', '654321')).reason, 'claimed')
        assert.equal(await store.transfer(guild, 'one@example.org', 'user-b'), 'user-a')
        assert.equal((await store.claimFor(guild, 'one@example.org')).user_id, 'user-b')
        assert.equal((await store.audit(guild))[0].action, 'account_transfer')
        await store.savePending(guild, 'user-a', 'one@example.org', '456789')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '456789')).reason, 'claimed')
        await store.replaceRoster(guild, [{ email: 'two@example.org', role: 'gm' }], 'admin')
        assert.deepEqual([...(await store.activeClaimUserIds(guild))], [])
        assert.equal(await store.isAuthorizedUser(guild, 'user-b'), false)
        assert.deepEqual(await store.removedClaims(guild), [
            {
                email: 'one@example.org',
                user_id: 'user-b',
                managed_role: 1,
                managed_exec_role: 1,
                managed_admin_role: 0
            }
        ])
        assert.equal(await store.releaseClaim(guild, 'one@example.org', 'admin'), 'user-b')
        assert.equal((await store.audit(guild))[0].action, 'claim_release')
        assert.deepEqual(await store.removedClaims(guild), [])
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('preserves pre-existing role ownership when an email claim is removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const store = new Store(path.join(dir, 'tvm.db'), 'c'.repeat(32))
    const guild = '123456789012345678'
    try {
        await store.replaceRoster(guild, [{ email: 'existing@example.org', role: 'admin' }], 'admin')
        await store.savePending(guild, 'user-a', 'existing@example.org', '123456')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456', { member: true, admin: true })).ok, true)
        assert.equal((await store.claimFor(guild, 'existing@example.org')).managed_role, 0)
        await store.replaceRoster(guild, [{ email: 'other@example.org', role: 'gm' }], 'admin')
        assert.deepEqual(await store.removedClaims(guild), [
            {
                email: 'existing@example.org',
                user_id: 'user-a',
                managed_role: 0,
                managed_exec_role: 0,
                managed_admin_role: 0
            }
        ])
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('transfers and repairs can start managing a previously external role', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const store = new Store(path.join(dir, 'tvm.db'), 'e'.repeat(32))
    const guild = '123456789012345678'
    try {
        await store.replaceRoster(guild, [{ email: 'existing@example.org', role: 'gm' }], 'admin')
        await store.savePending(guild, 'user-a', 'existing@example.org', '123456')
        await store.verifyAndClaim(guild, 'user-a', '123456', { member: true })
        await store.transfer(guild, 'existing@example.org', 'user-b', 'admin', { member: true })
        assert.equal((await store.claimFor(guild, 'existing@example.org')).managed_role, 0)
        await store.markRoleManaged(guild, 'existing@example.org', 'user-b')
        assert.equal((await store.claimFor(guild, 'existing@example.org')).managed_role, 1)
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('adds role ownership to a database created by the first email-only release', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const filename = path.join(dir, 'tvm.db')
    const db = new sqlite3.Database(filename)
    await new Promise((resolve, reject) =>
        db.exec(
            `CREATE TABLE email_claims (
        guild_id TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, email), UNIQUE (guild_id, user_id))`,
            (error) => (error ? reject(error) : resolve())
        )
    )
    await new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))
    const store = new Store(filename, 'd'.repeat(32))
    try {
        await store.ready
        const columns = await store._all('PRAGMA table_info(email_claims)')
        assert.equal(
            columns.some((column) => column.name === 'managed_role'),
            true
        )
        assert.equal(
            columns.some((column) => column.name === 'managed_exec_role'),
            true
        )
        assert.equal(
            columns.some((column) => column.name === 'managed_admin_role'),
            true
        )
        const rosterColumns = await store._all('PRAGMA table_info(email_roster)')
        assert.equal(
            rosterColumns.some((column) => column.name === 'role'),
            true
        )
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('tracks tier roles per claim and exposes roster changes for reconciliation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const store = new Store(path.join(dir, 'tvm.db'), 'f'.repeat(32))
    const guild = '123456789012345678'
    try {
        await store.replaceRoster(guild, [{ email: 'leader@example.org', role: 'admin' }], 'admin')
        await store.savePending(guild, 'user-a', 'leader@example.org', '123456')
        const result = await store.verifyAndClaim(guild, 'user-a', '123456', { member: true })
        assert.equal(result.role, 'admin')
        assert.deepEqual(await store.activeClaims(guild), [
            {
                email: 'leader@example.org',
                user_id: 'user-a',
                managed_role: 0,
                managed_exec_role: 0,
                managed_admin_role: 1,
                role: 'admin'
            }
        ])
        await store.replaceRoster(guild, [{ email: 'leader@example.org', role: 'exec' }], 'admin')
        assert.equal((await store.activeClaims(guild))[0].role, 'exec')
        await store.clearRoleManaged(guild, 'leader@example.org', 'user-a', 'admin')
        await store.markRoleManaged(guild, 'leader@example.org', 'user-a', 'exec')
        assert.deepEqual(await store.claimFor(guild, 'leader@example.org'), {
            user_id: 'user-a',
            managed_role: 0,
            managed_exec_role: 1,
            managed_admin_role: 0
        })
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('roster replacement invalidates pending codes and send limits apply', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const store = new Store(path.join(dir, 'tvm.db'), 'b'.repeat(32))
    const guild = '123456789012345678'
    try {
        await store.replaceRoster(guild, [{ email: 'old@example.org', role: 'gm' }], 'admin')
        await store.savePending(guild, 'user-a', 'old@example.org', '123456')
        await store.replaceRoster(guild, [{ email: 'new@example.org', role: 'gm' }], 'admin')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456')).reason, 'expired')
        assert.equal(await store.allowRequest(guild, 'user-a', 'new@example.org'), true)
        assert.equal(await store.reserveSend(guild, 'user-a', 'new@example.org'), true)
        assert.equal(await store.reserveSend(guild, 'user-a', 'new@example.org'), false)
        await assert.rejects(store.savePending(guild, 'user-b', 'old@example.org', '123456'), {
            message: uiText('errors.emailAbsent')
        })
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('roster uploads preserve omitted members and existing claims while adding roles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const store = new Store(path.join(dir, 'tvm.db'), 'g'.repeat(32))
    const guild = '123456789012345678'
    try {
        await store.replaceRoster(
            guild,
            [
                { email: 'existing@example.org', role: 'gm' },
                { email: 'omitted@example.org', role: 'gm' }
            ],
            'admin'
        )
        await store.savePending(guild, 'user-a', 'omitted@example.org', '123456')
        await store.verifyAndClaim(guild, 'user-a', '123456')
        const result = await store.mergeRoster(
            guild,
            [
                { email: 'existing@example.org', role: 'exec' },
                { email: 'new@example.org', role: 'admin' }
            ],
            'admin'
        )
        assert.deepEqual(result, { version: 2, uploaded: 2, count: 3 })
        assert.equal((await store.lookup(guild, 'omitted@example.org')).role, 'gm')
        assert.equal((await store.lookup(guild, 'existing@example.org')).role, 'exec')
        assert.equal((await store.lookup(guild, 'new@example.org')).role, 'admin')
        assert.equal((await store.claimFor(guild, 'omitted@example.org')).user_id, 'user-a')
        assert.deepEqual(await store.removedClaims(guild), [])
        await assert.rejects(store.mergeRoster(guild, [{ email: 'bad@example.org', role: 'owner' }], 'admin'), {
            message: uiText('errors.rosterInvalidRole')
        })
        assert.equal((await store.status(guild)).count, 3)
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('transaction failures roll back roster data, pending challenges, metadata, and audits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-rollback-'))
    const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
    const guild = '100000000000000001'
    try {
        await store.replaceRoster(guild, [{ email: 'member@example.org', role: 'gm' }], 'admin')
        await store.savePending(guild, 'user', 'member@example.org', '123456')
        const run = store._run.bind(store)
        store._run = (sql, params) => {
            if (sql.startsWith('INSERT INTO email_admin_audit')) return Promise.reject(new Error('audit write failed'))
            return run(sql, params)
        }
        await assert.rejects(
            store.replaceRoster(guild, [{ email: 'other@example.org', role: 'admin' }], 'admin'),
            /audit write failed/
        )
        store._run = run
        assert.deepEqual(await store.rosterEntries(guild), [{ email: 'member@example.org', role: 'gm' }])
        assert.equal((await store.status(guild)).meta.version, 1)
        assert.equal((await store.pendingFor(guild, 'user')).email, 'member@example.org')
        assert.equal((await store.audit(guild)).length, 1)
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('numbered migrations are recorded once and failed migration writes roll back schema changes', async () => {
    const { migrations } = require('../src/tvm/migrations')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-migrations-'))
    const filename = path.join(dir, 'test.db')
    let store = new Store(filename, 's'.repeat(32))
    try {
        await store.ready
        const applied = await store._all('SELECT version, applied_at FROM tvm_schema_migrations ORDER BY version')
        assert.deepEqual(
            applied.map((row) => row.version),
            migrations.map((item) => item.version)
        )
        await store.close()
        store = new Store(filename, 's'.repeat(32))
        await store.ready
        assert.deepEqual(
            await store._all('SELECT version, applied_at FROM tvm_schema_migrations ORDER BY version'),
            applied
        )
        await store._locked(() =>
            store._exec(
                'DELETE FROM tvm_schema_migrations WHERE version = 6; ALTER TABLE shoots DROP COLUMN announcement_republish_pending;'
            )
        )
        await store.close()
        store = new Store(filename, 's'.repeat(32))
        const run = store._run.bind(store)
        store._run = (sql, params) => {
            if (sql.startsWith('INSERT INTO tvm_schema_migrations'))
                return Promise.reject(new Error('migration write failed'))
            return run(sql, params)
        }
        await assert.rejects(store.ready, /migration write failed/)
        assert.equal(
            (await store._all('PRAGMA table_info(shoots)')).some(
                (row) => row.name === 'announcement_republish_pending'
            ),
            false
        )
        assert.equal((await store._get('SELECT MAX(version) AS version FROM tvm_schema_migrations')).version, 5)
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('closing the store drains queued writes, rejects new work, and is idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-close-'))
    const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
    try {
        const write = store.mergeRoster('100000000000000001', [{ email: 'member@example.org', role: 'gm' }], 'admin')
        const closing = store.close()
        assert.equal(store.close(), closing)
        await assert.rejects(store.status('100000000000000001'), /Store is closing/)
        assert.equal((await write).count, 1)
        await closing
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('cleanup removes expired draft participants atomically and preserves submitted and fresh shoots', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-drafts-'))
    const store = new Store(path.join(dir, 'test.db'), 's'.repeat(32))
    t.after(async () => {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    for (const id of ['expired', 'fresh', 'submitted']) await store.createShootDraft(id, 'guild', 'admin', ['member'])
    await store._run('UPDATE shoots SET created_at = ? WHERE id != ?', [Date.now() - 31 * 60000, 'fresh'])
    await store.updateShoot('submitted', { status: 'provisioning' })
    const original = store._run.bind(store)
    store._run = (sql, params) =>
        sql.startsWith('DELETE FROM shoots') ? Promise.reject(new Error('cleanup failed')) : original(sql, params)
    await assert.rejects(store.sweep(), /cleanup failed/)
    assert.equal((await store.shootParticipants('expired')).length, 2)
    assert.ok(await store.getShoot('expired', 'guild'))
    store._run = original
    await store.sweep()
    assert.equal(await store.getShoot('expired', 'guild'), undefined)
    assert.deepEqual(await store.shootParticipants('expired'), [])
    for (const id of ['fresh', 'submitted']) {
        assert.ok(await store.getShoot(id, 'guild'))
        assert.equal((await store.shootParticipants(id)).length, 2)
    }
})
