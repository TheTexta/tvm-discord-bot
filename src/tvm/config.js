// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { required, boolean, validEmail, validSnowflake } = require('./validation')

function loadShootConfig(env = process.env) {
    const names = ['TVM_SHOOT_ANNOUNCEMENT_CHANNEL_ID', 'TVM_SHOOT_CATEGORY_ID', 'TVM_SHOOT_ARCHIVE_CATEGORY_ID']
    const ids = names.map((name) => env[name]?.trim() || null)
    if (ids.every((id) => !id)) return null
    if (ids.some((id) => !id))
        throw new Error('Configure all three TVM_SHOOT_* channel/category IDs or leave all unset')
    ids.forEach((id, index) => {
        if (!validSnowflake(id)) throw new Error(`Invalid ${names[index]}`)
    })
    if (new Set(ids).size !== 3) throw new Error('Shoot announcement and category IDs must be distinct')
    return { announcementChannelId: ids[0], categoryId: ids[1], archiveCategoryId: ids[2] }
}

function loadConfig(env = process.env) {
    const config = {
        ...loadRosterConfig(env),
        token: required(env, 'DISCORD_BOT_TOKEN'),
        applicationId: required(env, 'DISCORD_APPLICATION_ID'),
        memberRoleId: required(env, 'TVM_MEMBER_ROLE_ID'),
        execRoleId: required(env, 'TVM_EXEC_ROLE_ID'),
        adminRoleId: required(env, 'TVM_ADMIN_ROLE_ID'),
        unverifiedRoleId: env.TVM_UNVERIFIED_ROLE_ID?.trim() || null,
        alertChannelId: required(env, 'TVM_ADMIN_ALERT_CHANNEL_ID'),
        smtpFrom: required(env, 'SMTP_FROM'),
        resendApiKey: required(env, 'RESEND_API_KEY'),
        autoRoleRevocation: boolean(env, 'TVM_AUTO_ROLE_REVOCATION'),
        smtpHost: env.SMTP_HOST || 'smtp.resend.com',
        smtpPort: Number(env.SMTP_PORT || 465),
        shoots: loadShootConfig(env)
    }
    for (const key of ['applicationId', 'guildId', 'memberRoleId', 'execRoleId', 'adminRoleId', 'alertChannelId']) {
        if (!validSnowflake(config[key])) throw new Error(`Invalid ${key}`)
    }
    if (new Set([config.memberRoleId, config.execRoleId, config.adminRoleId]).size !== 3)
        throw new Error('Configured role IDs must be distinct')
    if (
        config.unverifiedRoleId &&
        (!validSnowflake(config.unverifiedRoleId) ||
            [config.guildId, config.memberRoleId, config.execRoleId, config.adminRoleId].includes(
                config.unverifiedRoleId
            ))
    ) {
        throw new Error('Invalid or conflicting TVM_UNVERIFIED_ROLE_ID')
    }
    if (!validEmail(config.smtpFrom)) throw new Error('Invalid SMTP_FROM')
    if (config.smtpPort !== 465) throw new Error('The TVM runtime currently requires implicit TLS on SMTP port 465')
    return config
}

function loadRosterConfig(env = process.env) {
    const guildId = required(env, 'TVM_GUILD_ID')
    const codeSecret = required(env, 'VERIFICATION_CODE_SECRET')
    if (!validSnowflake(guildId)) throw new Error('Invalid guildId')
    if (codeSecret.length < 32) throw new Error('VERIFICATION_CODE_SECRET must contain at least 32 characters')
    return { guildId, codeSecret, databasePath: env.TVM_DATABASE_PATH?.trim() || '/usr/app/config/tvm.db' }
}

module.exports = { loadConfig, loadShootConfig, loadRosterConfig }
