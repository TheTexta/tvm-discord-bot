// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { DateTime } = require('luxon')
const {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    LabelBuilder,
    StringSelectMenuBuilder
} = require('discord.js')
const { uiText } = require('../shared/uiText')
const { JOIN_PERIODS, PERIOD_TEXT } = require('./policy')
const ZONE = 'America/Toronto'
const FORMAT = 'yyyy-MM-dd HH:mm'

function parseMembers(value = '') {
    const ids = [...value.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1])
    if (value.replace(/<@!?\d{17,20}>/g, '').replace(/[\s,]/g, '') || new Set(ids).size > 70) {
        throw new Error(uiText('shoot.mentions'))
    }
    return [...new Set(ids)]
}

function parseDetails(fields) {
    let name, location, date, clock, periods
    try {
        name = fields.getTextInputValue('name').trim()
        location = fields.getTextInputValue('location').trim()
        date = fields.getTextInputValue('date').trim()
        clock = fields.getTextInputValue('time').trim() || '12:00'
        periods = fields.getStringSelectValues('join_period')
    } catch {
        // Forms opened before a deployment may still use the previous input layout.
        throw new Error(uiText('shoot.expired'))
    }
    if (periods.length !== 1 || !Object.hasOwn(JOIN_PERIODS, periods[0]))
        throw new Error(uiText('shoot.invalidJoinPeriod'))
    const join_period = periods[0]
    if (!name || name.length > 100 || !location || location.length > 200)
        throw new Error(uiText('shoot.invalidDetails'))
    if (!date) return { name, location, call_time: null, join_period }
    const value = `${date} ${clock}`
    const time = DateTime.fromFormat(value, FORMAT, { zone: ZONE, locale: 'en' })
    // Luxon normalizes DST gaps forward: round-trip to reject that normalization.
    if (
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ||
        !time.isValid ||
        time.toFormat(FORMAT) !== value ||
        time.getPossibleOffsets().length !== 1
    )
        throw new Error(uiText('shoot.invalidTime'))
    return { name, location, call_time: time.toMillis(), join_period }
}

function shootCommand() {
    return (
        new SlashCommandBuilder()
            .setName('shoot')
            .setDescription(uiText('shoot.command'))
            // Authorization is checked for every command and modal. Administrator-only
            // defaults would hide the command from members with the Admin Team role.
            .setDefaultMemberPermissions(null)
            .addSubcommand((s) =>
                s
                    .setName('setup')
                    .setDescription(uiText('shoot.setup'))
                    .addStringOption((o) =>
                        o.setName('members').setDescription(uiText('shoot.membersOption')).setMaxLength(1700)
                    )
            )
            .addSubcommand((s) => s.setName('edit').setDescription(uiText('shoot.edit')))
            .addSubcommand((s) => s.setName('crew').setDescription(uiText('shoot.crew')))
            .addSubcommand((s) =>
                s
                    .setName('add')
                    .setDescription(uiText('shoot.add'))
                    .addUserOption((o) =>
                        o.setName('user').setDescription(uiText('shoot.addUserOption')).setRequired(true)
                    )
            )
            .addSubcommand((s) => s.setName('close').setDescription(uiText('shoot.close')))
            .addSubcommand((s) => s.setName('reopen').setDescription(uiText('shoot.reopen')))
            .toJSON()
    )
}

function modal(shoot, edit = false) {
    const id = `tvm:shoot:${edit ? 'edit' : 'setup'}:${shoot.id}${edit ? `:${shoot.revision}` : ''}`
    const inputs = [
        ['name', uiText('shoot.nameLabel'), 100, shoot.name, true],
        [
            'date',
            uiText('shoot.dateLabel'),
            10,
            shoot.call_time != null ? DateTime.fromMillis(shoot.call_time, { zone: ZONE }).toFormat('yyyy-MM-dd') : '',
            false
        ],
        [
            'time',
            uiText('shoot.timeLabel'),
            5,
            shoot.call_time != null ? DateTime.fromMillis(shoot.call_time, { zone: ZONE }).toFormat('HH:mm') : '',
            false
        ],
        ['location', uiText('shoot.locationLabel'), 200, shoot.location, true]
    ]
    const select = new StringSelectMenuBuilder()
        .setCustomId('join_period')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true)
        .addOptions(
            Object.keys(JOIN_PERIODS).map((value) => ({
                label: uiText(PERIOD_TEXT[value]),
                value,
                default: value === shoot.join_period
            }))
        )
    return new ModalBuilder()
        .setCustomId(id)
        .setTitle(edit ? uiText('shoot.editTitle') : uiText('shoot.setupTitle'))
        .addLabelComponents(
            ...inputs.map(([id, label, max, value, required]) => {
                const input = new TextInputBuilder()
                    .setCustomId(id)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(required)
                    .setMaxLength(max)
                if (value) input.setValue(value)
                return new LabelBuilder().setLabel(label).setTextInputComponent(input)
            }),
            new LabelBuilder()
                .setLabel(uiText('shoot.joinLabel'))
                .setDescription(uiText('shoot.joinDescription'))
                .setStringSelectMenuComponent(select)
        )
}

module.exports = { parseMembers, parseDetails, shootCommand, modal }
