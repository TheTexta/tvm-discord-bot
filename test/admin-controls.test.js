// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const discord = require('discord.js')
const { canManageBot } = require('../src/tvm/permissions')

const adminRoleId = '100000000000000012'
const guildId = '100000000000000001'

function runtime() {
    const events = new Map(), mail = [], sent = []
    class Client {
        on(event, callback) { events.set(event, callback) }
        once() {}
        async login() {} // Never connect this test runtime to Discord.
    }
    class Store {
        async status() { return { count: 2, unreconciled: 0, meta: { version: 1 } } }
        async audit() { return [] }
        async lookup() { return null }
        async claimFor() { return null }
        async activeClaims() { return [] }
    }
    class Mail { async sendMail(payload) { mail.push(payload) } }
    class Unverified { async syncGuild() { return { added: 0, removed: 0, failed: 0 } } }
    const filename = path.join(__dirname, '../src/tvm/App.js')
    const realRequire = createRequire(filename)
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = commands', {
        module, console: { error() {} }, process: { exit() { throw new Error('Unexpected exit') } },
        require: name => {
            if (name === 'discord.js') return { ...discord, Client }
            if (name === './config') return { loadConfig: () => ({ guildId, adminRoleId }) }
            if (name === './Store') return Store
            if (name === './UnverifiedRoleManager') return Unverified
            if (name === '../mail/providers/SelfSmtpProvider') return Mail
            if (name === './ShootService') return { ShootService: class { async handleInteraction() { return false } } }
            return realRequire(name)
        }
    })
    function interaction(commandName, { role = true, administrator = false, bot = false, subcommand = 'status' } = {}) {
        return {
            commandName, guildId, user: { id: '100000000000000003', bot },
            member: { roles: { cache: new discord.Collection(role ? [[adminRoleId, {}]] : []) } },
            memberPermissions: new discord.PermissionsBitField(administrator ? discord.PermissionFlagsBits.Administrator : 0n),
            options: { getSubcommand: () => subcommand, getString: () => 'example@example.org', getAttachment: () => null,
                getUser: () => ({ id: '100000000000000004' }) },
            guild: {}, channel: { send: async payload => sent.push(payload) }, replies: [],
            isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => true,
            async reply(payload) { this.replied = true; this.replies.push(payload) },
            async deferReply() { this.deferred = true },
            async editReply(payload) { this.replies.push(payload) },
            async showModal() { this.modal = true }
        }
    }
    return { handle: events.get('interactionCreate'), interaction, commands: module.exports, mail, sent }
}

test('Admin Team and Discord administrators can use the active runtime’s management commands', async () => {
    for (const authority of [{ role: true }, { role: false, administrator: true }]) {
        const app = runtime()
        for (const command of ['postverify', 'testmail', 'upload', 'roster']) {
            const interaction = app.interaction(command, authority)
            await app.handle(interaction)
            assert.doesNotMatch(interaction.replies.at(-1).content, /need.*permission/)
            assert.equal(Boolean(interaction.deferred || interaction.replied), true)
        }
        assert.equal(app.sent.length, 1)
        assert.equal(app.mail.length, 1)
        for (const subcommand of ['audit', 'reconcile', 'repair', 'release', 'transfer']) {
            const interaction = app.interaction('roster', { ...authority, subcommand })
            await app.handle(interaction)
            assert.equal(interaction.deferred, true, subcommand)
            assert.doesNotMatch(interaction.replies.at(-1).content, /need.*permission/)
            if (['audit', 'reconcile'].includes(subcommand)) {
                assert.doesNotMatch(interaction.replies.at(-1).content, /Something went wrong/)
            }
        }
        for (const command of app.commands.filter(command => !['verify', 'source'].includes(command.name))) {
            assert.equal(command.default_member_permissions, null, command.name)
        }
    }
})

test('ordinary members and bots cannot invoke management commands; verification remains public', async () => {
    const app = runtime()
    for (const authority of [{ role: false }, { role: true, bot: true }, { role: false, administrator: true, bot: true }]) {
        for (const command of ['postverify', 'testmail', 'upload', 'roster']) {
            const interaction = app.interaction(command, authority)
            await app.handle(interaction)
            assert.match(interaction.replies.at(-1).content, /Admin Team role or Discord Administrator/)
            assert.equal(interaction.deferred, undefined)
        }
    }
    assert.equal(app.sent.length, 0)
    assert.equal(app.mail.length, 0)
    const verify = app.interaction('verify', { role: false })
    await app.handle(verify)
    assert.equal(verify.modal, true)
    const source = app.interaction('source', { role: false })
    await app.handle(source)
    assert.match(source.replies.at(-1).content, /github.com/)
    const wrongGuild = app.interaction('testmail')
    wrongGuild.guildId = '100000000000000099'
    await app.handle(wrongGuild)
    assert.equal(wrongGuild.replies.length, 0)
})

test('authorization supports raw member roles, rejects namesakes, and rechecks role removal', () => {
    const app = runtime()
    const interaction = app.interaction('roster', { role: false })
    interaction.member = { roles: [adminRoleId] }
    assert.equal(canManageBot(interaction, adminRoleId), true)
    interaction.member.roles = ['100000000000000099']
    assert.equal(canManageBot(interaction, adminRoleId), false)
    interaction.member = null
    assert.equal(canManageBot(interaction, adminRoleId), false)
})
