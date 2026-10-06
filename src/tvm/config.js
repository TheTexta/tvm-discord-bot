// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

function required(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
}

function loadShootConfig(env = process.env) {
    const names = ['TVM_SHOOT_ANNOUNCEMENT_CHANNEL_ID', 'TVM_SHOOT_CATEGORY_ID', 'TVM_SHOOT_ARCHIVE_CATEGORY_ID']
    const ids = names.map(name => env[name]?.trim() || null)
    if (ids.every(id => !id)) return null
    if (ids.some(id => !id)) throw new Error('Configure all three TVM_SHOOT_* channel/category IDs or leave all unset')
    ids.forEach((id, index) => {
        if (!/^\d{17,20}$/.test(id)) throw new Error(`Invalid ${names[index]}`)
    })
    if (new Set(ids).size !== 3) throw new Error('Shoot announcement and category IDs must be distinct')
    return { announcementChannelId: ids[0], categoryId: ids[1], archiveCategoryId: ids[2] }
}

function loadConfig() {
    const config = {
        token: required('DISCORD_BOT_TOKEN'),
        applicationId: required('DISCORD_APPLICATION_ID'),
        guildId: required('TVM_GUILD_ID'),
        memberRoleId: required('TVM_MEMBER_ROLE_ID'),
        execRoleId: required('TVM_EXEC_ROLE_ID'),
        adminRoleId: required('TVM_ADMIN_ROLE_ID'),
        unverifiedRoleId: process.env.TVM_UNVERIFIED_ROLE_ID?.trim() || null,
        alertChannelId: required('TVM_ADMIN_ALERT_CHANNEL_ID'),
        smtpFrom: required('SMTP_FROM'),
        resendApiKey: required('RESEND_API_KEY'),
        codeSecret: required('VERIFICATION_CODE_SECRET'),
        autoRoleRevocation: process.env.TVM_AUTO_ROLE_REVOCATION === 'true',
        databasePath: process.env.TVM_DATABASE_PATH || '/usr/app/config/tvm.db',
        smtpHost: process.env.SMTP_HOST || 'smtp.resend.com',
        smtpPort: Number(process.env.SMTP_PORT || 465),
        shoots: loadShootConfig()
    }
    for (const key of ['applicationId', 'guildId', 'memberRoleId', 'execRoleId', 'adminRoleId', 'alertChannelId']) {
        if (!/^\d{17,20}$/.test(config[key])) throw new Error(`Invalid ${key}`)
    }
    if (new Set([config.memberRoleId, config.execRoleId, config.adminRoleId]).size !== 3) throw new Error('Configured role IDs must be distinct')
    if (config.unverifiedRoleId && (!/^\d{17,20}$/.test(config.unverifiedRoleId) ||
        [config.guildId, config.memberRoleId, config.execRoleId, config.adminRoleId].includes(config.unverifiedRoleId))) {
        throw new Error('Invalid or conflicting TVM_UNVERIFIED_ROLE_ID')
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.smtpFrom)) throw new Error('Invalid SMTP_FROM')
    if (config.codeSecret.length < 32) throw new Error('VERIFICATION_CODE_SECRET must contain at least 32 characters')
    if (config.smtpPort !== 465) throw new Error('The TVM runtime currently requires implicit TLS on SMTP port 465')
    return config
}

module.exports = { loadConfig, loadShootConfig }
