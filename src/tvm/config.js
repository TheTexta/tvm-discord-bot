// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

function required(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
}

function loadConfig() {
    const config = {
        token: required('DISCORD_BOT_TOKEN'),
        applicationId: required('DISCORD_APPLICATION_ID'),
        guildId: required('TVM_GUILD_ID'),
        memberRoleId: required('TVM_MEMBER_ROLE_ID'),
        alertChannelId: required('TVM_ADMIN_ALERT_CHANNEL_ID'),
        smtpFrom: required('SMTP_FROM'),
        resendApiKey: required('RESEND_API_KEY'),
        codeSecret: required('VERIFICATION_CODE_SECRET'),
        databasePath: process.env.TVM_DATABASE_PATH || '/usr/app/config/tvm.db',
        smtpHost: process.env.SMTP_HOST || 'smtp.resend.com',
        smtpPort: Number(process.env.SMTP_PORT || 465)
    }
    for (const key of ['applicationId', 'guildId', 'memberRoleId', 'alertChannelId']) {
        if (!/^\d{17,20}$/.test(config[key])) throw new Error(`Invalid ${key}`)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.smtpFrom)) throw new Error('Invalid SMTP_FROM')
    if (config.codeSecret.length < 32) throw new Error('VERIFICATION_CODE_SECRET must contain at least 32 characters')
    if (config.smtpPort !== 465) throw new Error('The TVM runtime currently requires implicit TLS on SMTP port 465')
    return config
}

module.exports = { loadConfig }
