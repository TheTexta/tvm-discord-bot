// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')

const EMOJI = '🎬'
const JOIN_PERIODS = { day: 1, two_days: 2, week: 7, month: 30, never: null }
const PERIOD_TEXT = {
    day: 'shoot.joinDay',
    two_days: 'shoot.joinTwoDays',
    week: 'shoot.joinWeek',
    month: 'shoot.joinMonth',
    never: 'shoot.joinNever'
}
const READ = [P.ViewChannel, P.ReadMessageHistory]
const WRITE = [P.SendMessages, P.SendMessagesInThreads, P.AddReactions]
const THREADS = [P.CreatePublicThreads, P.CreatePrivateThreads]
const BOT_PERMISSIONS = [...READ, ...WRITE, P.EmbedLinks, P.AttachFiles, P.ManageChannels, P.ManageRoles, P.PinMessages]
const ANNOUNCEMENT_PERMISSIONS = [...READ, P.SendMessages, P.EmbedLinks, P.AddReactions, P.ManageMessages]
const ACTIVE_STATUSES = ['provisioning', 'open', 'closing', 'closed', 'reopening']
const noMentions = { parse: [] }

function joinDeadline(shoot) {
    const days = JOIN_PERIODS[shoot.join_period]
    return days == null || shoot.join_started_at == null ? null : shoot.join_started_at + days * 86400000
}

function joiningAllowed(shoot, now = Date.now()) {
    const deadline = joinDeadline(shoot)
    return (
        shoot.announcement_deleted_at == null &&
        ['open', 'reopening'].includes(shoot.status) &&
        (deadline == null || now < deadline)
    )
}

function overwrites(guildId, botId, participantIds, closed, adminRoleId, adminParticipantIds = new Set()) {
    const everyoneDeny = [...WRITE, ...THREADS, P.ViewChannel]
    return [
        { id: guildId, type: 0, allow: [], deny: everyoneDeny },
        { id: botId, type: 1, allow: BOT_PERMISSIONS, deny: [] },
        ...(adminRoleId
            ? [
                  {
                      id: adminRoleId,
                      type: 0,
                      allow: [...READ, ...WRITE, P.AttachFiles, P.EmbedLinks, P.UseApplicationCommands],
                      deny: THREADS
                  }
              ]
            : []),
        ...[...new Set(participantIds)]
            .filter((id) => id !== botId)
            .map((id) => ({
                id,
                type: 1,
                allow: closed && !adminParticipantIds.has(id) ? READ : [...READ, ...WRITE, P.AttachFiles, P.EmbedLinks],
                deny: closed && !adminParticipantIds.has(id) ? [...WRITE, ...THREADS] : THREADS
            }))
    ]
}

function overwriteKey(entries) {
    return JSON.stringify(
        entries
            .map((entry) => [
                entry.id,
                entry.type,
                String(PermissionsBitField.resolve(entry.allow)),
                String(PermissionsBitField.resolve(entry.deny))
            ])
            .sort((a, b) => a[0].localeCompare(b[0]))
    )
}

function embedKey(embed) {
    if (!embed) return null
    const data = embed.toJSON()
    // Discord adds fields such as type: rich and inline: false to REST responses.
    // Compare the rendered values so unchanged briefs do not get edited every minute.
    return JSON.stringify([
        data.title,
        data.description,
        data.color,
        data.footer?.text,
        data.fields?.map((field) => [field.name, field.value, Boolean(field.inline)])
    ])
}

module.exports = {
    EMOJI,
    JOIN_PERIODS,
    PERIOD_TEXT,
    BOT_PERMISSIONS,
    ANNOUNCEMENT_PERMISSIONS,
    ACTIVE_STATUSES,
    noMentions,
    joinDeadline,
    joiningAllowed,
    overwrites,
    overwriteKey,
    embedKey
}
