// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../src/tvm/Store')

test('requires a roster email, persists codes, and binds one Discord account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-store-'))
    const filename = path.join(dir, 'tvm.db')
    const guild = '123456789012345678'
    let store = new Store(filename, 'a'.repeat(32))
    try {
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
        assert.deepEqual(await store.status(guild), { meta: undefined, count: 0, unreconciled: 0 })
        await store.replaceRoster(guild, [
            { email: 'one@example.org' }, { email: 'two@example.org' }
        ], 'admin')
        await assert.rejects(store.replaceRoster(guild, [
            { email: 'three@example.org' }, { email: 'THREE@example.org' }
        ], 'admin'), /duplicate emails/)
        assert.equal((await store.status(guild)).count, 2)
        assert.equal((await store.lookup(guild, 'ONE@example.org')).email, 'one@example.org')
        assert.equal(await store.lookup(guild, 'outsider@example.org'), undefined)
        await store.savePending(guild, 'user-a', 'one@example.org', '123456')
        await store.close()
        store = new Store(filename, 'a'.repeat(32))
        assert.equal((await store.pendingFor(guild, 'user-a')).email, 'one@example.org')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '000000')).reason, 'invalid')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456')).ok, true)
        assert.deepEqual([...await store.activeClaimUserIds(guild)], ['user-a'])
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
        await store.replaceRoster(guild, [{ email: 'two@example.org' }], 'admin')
        assert.deepEqual([...await store.activeClaimUserIds(guild)], [])
        assert.equal(await store.isAuthorizedUser(guild, 'user-b'), false)
        assert.deepEqual(await store.removedClaims(guild), [{ email: 'one@example.org', user_id: 'user-b' }])
        assert.equal(await store.releaseClaim(guild, 'one@example.org', 'admin'), 'user-b')
        assert.equal((await store.audit(guild))[0].action, 'claim_release')
        assert.deepEqual(await store.removedClaims(guild), [])
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
        await store.replaceRoster(guild, [{ email: 'old@example.org' }], 'admin')
        await store.savePending(guild, 'user-a', 'old@example.org', '123456')
        await store.replaceRoster(guild, [{ email: 'new@example.org' }], 'admin')
        assert.equal((await store.verifyAndClaim(guild, 'user-a', '123456')).reason, 'expired')
        assert.equal(await store.allowRequest(guild, 'user-a', 'new@example.org'), true)
        assert.equal(await store.reserveSend(guild, 'user-a', 'new@example.org'), true)
        assert.equal(await store.reserveSend(guild, 'user-a', 'new@example.org'), false)
        await assert.rejects(store.savePending(guild, 'user-b', 'old@example.org', '123456'), /absent/)
    } finally {
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
