// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { EmbedBuilder, escapeMarkdown } = require('discord.js')
const { uiText } = require('../shared/uiText')
const { shootMarker } = require('./identifiers')
const { joinDeadline, PERIOD_TEXT, noMentions } = require('./policy')

function renderShoot(shoot, kind, closed, now = Date.now()) {
    const deadline = joinDeadline(shoot)
    const expired = deadline != null && now >= deadline
    const joinValue =
        shoot.announcement_deleted_at != null
            ? uiText('shoot.joinUnavailable')
            : deadline != null
              ? `<t:${Math.floor(deadline / 1000)}:F>`
              : shoot.join_period === 'never'
                ? uiText('shoot.joinNever')
                : uiText('shoot.joinPending', { period: uiText(PERIOD_TEXT[shoot.join_period]) })
    const embed = new EmbedBuilder()
        .setTitle(escapeMarkdown(shoot.name))
        .setColor(closed ? 0x747f8d : 0x9b59b6)
        .setDescription(closed ? uiText('shoot.statusClosed') : uiText('shoot.statusOpen'))
        .addFields(
            {
                name: uiText('shoot.callField'),
                value:
                    shoot.call_time == null
                        ? uiText('shoot.unscheduled')
                        : `<t:${Math.floor(shoot.call_time / 1000)}:F>`
            },
            { name: uiText('shoot.locationField'), value: escapeMarkdown(shoot.location) },
            { name: uiText('shoot.organizerField'), value: `<@${shoot.organizer_id}>` },
            { name: uiText('shoot.chatField'), value: `<#${shoot.channel_id}>` },
            { name: uiText('shoot.joinField'), value: joinValue }
        )
        .setFooter({ text: shootMarker(shoot.id, kind) })
    return {
        embeds: [embed],
        content:
            kind === 'invitation'
                ? closed
                    ? uiText('shoot.closedInvitation')
                    : expired
                      ? uiText('shoot.expiredInvitation')
                      : uiText('shoot.invitation')
                : '',
        allowedMentions: noMentions
    }
}

function memberFields(label, mentions) {
    const chunks = mentions.match(/.{1,1000}(?:\s|$)/g) || [mentions]
    return chunks.map((value) => ({ name: label, value: value.trim() }))
}

module.exports = { renderShoot, memberFields }
