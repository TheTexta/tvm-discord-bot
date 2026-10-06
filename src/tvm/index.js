// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { Client, GatewayIntentBits } = require('discord.js')
const { validateUiText } = require('./uiText')
const { loadConfig } = require('./config')
const { createApp } = require('./App')
const Store = require('./Store')
const { partials } = require('./ShootService')
const SelfSmtpProvider = require('../mail/providers/SelfSmtpProvider')

async function main() {
    process.umask(0o077)
    validateUiText()
    const config = loadConfig()
    const store = new Store(config.databasePath, config.codeSecret)
    const mail = new SelfSmtpProvider({
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        isSecure: true,
        username: 'resend',
        password: config.resendApiKey,
        fromAddress: config.smtpFrom
    })
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            ...(config.shoots ? [GatewayIntentBits.GuildMessageReactions] : [])
        ],
        partials: config.shoots ? partials : []
    })
    const app = createApp({
        config,
        store,
        mail,
        client
    })
    function stop() {
        return app.shutdown().catch((error) => {
            console.error('[TVM] Shutdown failed:', error.message)
            // A hung external operation must not keep a terminating container alive.
            process.exit(1)
        })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    try {
        await store.ready
        await app.start()
    } catch (error) {
        console.error('[TVM] Startup failed:', error?.message || error)
        process.exitCode = 1
        await stop()
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[TVM] Startup failed:', error?.message || error)
        process.exitCode = 1
    })
}

module.exports = { main }
