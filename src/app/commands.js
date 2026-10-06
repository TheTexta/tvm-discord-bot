// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { SlashCommandBuilder } = require('discord.js')
const { uiText } = require('../shared/uiText')
const { shootCommand } = require('../shoots/forms')

function buildCommands(shootsEnabled) {
    const commands = [
        new SlashCommandBuilder().setName('verify').setDescription(uiText('commands.verify')),
        new SlashCommandBuilder().setName('source').setDescription(uiText('commands.source')),
        new SlashCommandBuilder()
            .setName('postverify')
            .setDescription(uiText('commands.postverify'))
            .setDefaultMemberPermissions(null),
        new SlashCommandBuilder()
            .setName('testmail')
            .setDescription(uiText('commands.testmail'))
            .setDefaultMemberPermissions(null)
            .addStringOption((o) =>
                o.setName('email').setDescription(uiText('commands.destinationEmail')).setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('upload')
            .setDescription(uiText('commands.upload'))
            .setDefaultMemberPermissions(null)
            .addAttachmentOption((o) => o.setName('csv').setDescription(uiText('commands.csv')).setRequired(true)),
        new SlashCommandBuilder()
            .setName('roster')
            .setDescription(uiText('commands.roster'))
            .setDefaultMemberPermissions(null)
            .addSubcommand((s) => s.setName('status').setDescription(uiText('commands.status')))
            .addSubcommand((s) => s.setName('audit').setDescription(uiText('commands.audit')))
            .addSubcommand((s) => s.setName('reconcile').setDescription(uiText('commands.reconcile')))
            .addSubcommand((s) =>
                s
                    .setName('repair')
                    .setDescription(uiText('commands.repair'))
                    .addStringOption((o) =>
                        o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true)
                    )
            )
            .addSubcommand((s) =>
                s
                    .setName('release')
                    .setDescription(uiText('commands.release'))
                    .addStringOption((o) =>
                        o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true)
                    )
            )
            .addSubcommand((s) =>
                s
                    .setName('transfer')
                    .setDescription(uiText('commands.transfer'))
                    .addStringOption((o) =>
                        o.setName('email').setDescription(uiText('commands.rosterEmail')).setRequired(true)
                    )
                    .addUserOption((o) =>
                        o.setName('user').setDescription(uiText('commands.newAccount')).setRequired(true)
                    )
            )
    ].map((command) => command.toJSON())
    if (shootsEnabled) commands.push(shootCommand())
    return commands
}

module.exports = { buildCommands }
