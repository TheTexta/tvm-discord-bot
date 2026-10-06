// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadConfig, loadRosterConfig } = require('../src/tvm/config')

const env = {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '100000000000000001',
    TVM_GUILD_ID: '100000000000000002',
    TVM_MEMBER_ROLE_ID: '100000000000000003',
    TVM_EXEC_ROLE_ID: '100000000000000004',
    TVM_ADMIN_ROLE_ID: '100000000000000005',
    TVM_ADMIN_ALERT_CHANNEL_ID: '100000000000000006',
    SMTP_FROM: 'verify@example.org',
    RESEND_API_KEY: 'test-api-key',
    VERIFICATION_CODE_SECRET: 's'.repeat(32)
}

test('configuration uses injected environment, validates booleans, and rejects unsafe IDs', () => {
    assert.equal(loadConfig(env).autoRoleRevocation, false)
    assert.equal(loadConfig({ ...env, TVM_AUTO_ROLE_REVOCATION: ' true ' }).autoRoleRevocation, true)
    assert.equal(loadConfig({ ...env, TVM_AUTO_ROLE_REVOCATION: 'false' }).autoRoleRevocation, false)
    for (const value of ['TRUE', 'yes', '0', 'tru']) {
        assert.throws(() => loadConfig({ ...env, TVM_AUTO_ROLE_REVOCATION: value }), /must be true or false/)
    }
    assert.throws(() => loadConfig({ ...env, DISCORD_BOT_TOKEN: ' ' }), /Missing required/)
    assert.throws(() => loadConfig({ ...env, TVM_MEMBER_ROLE_ID: 'invalid' }), /Invalid/)
    assert.throws(() => loadConfig({ ...env, TVM_EXEC_ROLE_ID: env.TVM_MEMBER_ROLE_ID }), /distinct/)
    assert.throws(() => loadConfig({ ...env, TVM_UNVERIFIED_ROLE_ID: env.TVM_ADMIN_ROLE_ID }), /conflicting/)
    assert.throws(() => loadConfig({ ...env, SMTP_FROM: 'invalid' }), /SMTP_FROM/)
    assert.throws(() => loadConfig({ ...env, SMTP_PORT: '587' }), /implicit TLS/)
    assert.throws(() => loadConfig({ ...env, VERIFICATION_CODE_SECRET: 'short' }), /32 characters/)
})

test('roster maintenance configuration needs only validated database and guild credentials', () => {
    assert.deepEqual(
        loadRosterConfig({
            TVM_GUILD_ID: env.TVM_GUILD_ID,
            VERIFICATION_CODE_SECRET: env.VERIFICATION_CODE_SECRET,
            TVM_DATABASE_PATH: ' ./config/test.db '
        }),
        {
            guildId: env.TVM_GUILD_ID,
            codeSecret: env.VERIFICATION_CODE_SECRET,
            databasePath: './config/test.db'
        }
    )
})
