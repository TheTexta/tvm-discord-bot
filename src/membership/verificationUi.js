// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js')
const { uiText } = require('../shared/uiText')

const codeRow = () =>
    new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tvm:open-code')
            .setLabel(uiText('buttons.enterCode'))
            .setStyle(ButtonStyle.Primary)
    )

function emailModal() {
    return new ModalBuilder()
        .setCustomId('tvm:email')
        .setTitle(uiText('modals.emailTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('email')
                    .setLabel(uiText('modals.emailLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(254)
            )
        )
}

function codeModal() {
    return new ModalBuilder()
        .setCustomId('tvm:code')
        .setTitle(uiText('modals.codeTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('code')
                    .setLabel(uiText('modals.codeLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(6)
                    .setMaxLength(6)
            )
        )
}

module.exports = { codeRow, emailModal, codeModal }
