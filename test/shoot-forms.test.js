// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadShootConfig } = require('../src/app/config')
const { shootCommand, parseMembers, parseDetails, joinDeadline, joiningAllowed } = require('../src/shoots/ShootService')
const { IDS, fields, fixture } = require('./helpers/shoot')

test('shoot configuration is optional, complete, distinct, and validates snowflakes', () => {
    assert.equal(loadShootConfig({}), null)
    assert.throws(() => loadShootConfig({ TVM_SHOOT_CATEGORY_ID: IDS.active }))
    const env = {
        TVM_SHOOT_ANNOUNCEMENT_CHANNEL_ID: IDS.announce,
        TVM_SHOOT_CATEGORY_ID: IDS.active,
        TVM_SHOOT_ARCHIVE_CATEGORY_ID: IDS.archive
    }
    assert.equal(loadShootConfig(env).categoryId, IDS.active)
    assert.throws(() => loadShootConfig({ ...env, TVM_SHOOT_ARCHIVE_CATEGORY_ID: IDS.active }))
    assert.throws(() => loadShootConfig({ ...env, TVM_SHOOT_CATEGORY_ID: 'bad' }))
    const command = shootCommand()
    assert.equal(command.default_member_permissions, null)
    assert.deepEqual(
        command.options.map((option) => option.name),
        ['setup', 'edit', 'crew', 'add', 'close', 'reopen']
    )
})

test('validates mention input and Toronto calendar/DST times', () => {
    assert.deepEqual(parseMembers(`<@${IDS.invited}>, <@!${IDS.joined}> <@${IDS.invited}>`), [IDS.invited, IDS.joined])
    assert.deepEqual(parseMembers(''), [])
    for (const input of ['@everyone', 'Alice', `<@&${IDS.invited}>`, '<@123>', `<@${IDS.joined}> unwanted`])
        assert.throws(() => parseMembers(input))
    assert.equal(parseDetails(fields()).call_time, Date.parse('2026-10-15T17:30:00Z'))
    for (const time of [
        '2026-02-30 10:00',
        '2026-03-08 02:30',
        '2026-11-01 01:30',
        '2026-10-15 25:00',
        '2026-10-5 13:30'
    ]) {
        assert.throws(() => parseDetails(fields('Shoot', time)))
    }
    assert.equal(parseDetails(fields('Shoot', '2026-12-15 13:30')).call_time, Date.parse('2026-12-15T18:30:00Z'))
    assert.throws(() => parseDetails(fields('', '2026-10-15 13:30')))
})

test('edit updates both messages without notifications and rejects stale forms; crew is private', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('New name', '2026-12-01 09:00', 'Outside')
    await f.service.handleInteraction(submit)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).name, 'New name')
    for (const [channelId, messageId] of [
        [shoot.channel_id, shoot.brief_id],
        [IDS.announce, shoot.announcement_id]
    ]) {
        const message = f.channels.get(channelId).messages.cache.get(messageId)
        assert.equal(message.embeds[0].toJSON().title, 'New name')
        assert.deepEqual(message.edits.at(-1).allowedMentions, { parse: [] })
    }
    const stale = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    await f.service.handleInteraction(stale)
    assert.ok(stale.replies.at(-1).content.includes('expired'))
    const crew = f.interaction({ command: 'crew', channelId: shoot.channel_id })
    await f.service.handleInteraction(crew)
    assert.equal(crew.deferred, true)
    assert.ok(crew.replies.at(-1).embeds[0].toJSON().fields[0].value.includes(IDS.invited))
    assert.deepEqual(crew.replies.at(-1).allowedMentions, { parse: [] })
})

test('expired, cross-channel, invalid-time, and replayed setup forms cannot create additional chats', async (t) => {
    const f = await fixture(t)
    const setup = f.interaction({ command: 'setup' })
    await f.service.handleInteraction(setup)
    const id = setup.modal.custom_id.split(':')[3]
    await f.store._locked(() =>
        f.store._run('UPDATE shoots SET created_at = ? WHERE id = ?', [Date.now() - 31 * 60000, id])
    )
    await f.service.handleInteraction(f.interaction({ customId: setup.modal.custom_id }))
    assert.equal((await f.store.getShoot(id, IDS.guild)).status, 'draft')
    const created = await f.create()
    const count = f.channels.size
    await f.service.handleInteraction(f.interaction({ customId: created.setup.modal.custom_id }))
    assert.equal(f.channels.size, count)
    const edit = f.interaction({ command: 'edit', channelId: created.shoot.channel_id })
    await f.service.handleInteraction(edit)
    const wrongChannel = f.interaction({ customId: edit.modal.custom_id })
    await f.service.handleInteraction(wrongChannel)
    assert.ok(wrongChannel.replies.at(-1).content.includes('expired'))
    const invalid = f.interaction({ customId: edit.modal.custom_id, channelId: created.shoot.channel_id })
    invalid.fields = fields('New', '2026-11-01 01:30')
    await f.service.handleInteraction(invalid)
    assert.equal((await f.store.getShoot(created.id, IDS.guild)).name, 'TVM film')
})

test('blank time means Toronto noon and blank date means no scheduled timestamp', async (t) => {
    assert.equal(parseDetails(fields('Shoot', '2026-10-15')).call_time, Date.parse('2026-10-15T16:00:00Z'))
    assert.equal(parseDetails(fields('Shoot', '2026-12-15')).call_time, Date.parse('2026-12-15T17:00:00Z'))
    assert.equal(parseDetails(fields('Shoot', '')).call_time, null)
    assert.equal(parseDetails(fields('Shoot', ' 09:30')).call_time, null)
    for (const period of ['day', 'two_days', 'week', 'month', 'never'])
        assert.equal(parseDetails(fields('Shoot', '', 'Studio', period)).join_period, period)
    assert.throws(() => parseDetails(fields('Shoot', '', 'Studio', 'invalid')), /Choose/)
    assert.throws(() => parseDetails({ ...fields(), getStringSelectValues: () => [] }), /Choose/)
    const f = await fixture(t)
    const { shoot } = await f.create(fields('Undated shoot', ''))
    assert.equal(shoot.call_time, null)
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.messages.cache.get(shoot.brief_id).embeds[0].fields[0].value, 'Unscheduled')
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const inputs = edit.modal.components.map((label) => label.component)
    assert.equal(inputs[1].value, undefined)
    assert.equal(inputs[2].value, undefined)
})

test('joining periods use elapsed days and enforce the exact expiry boundary independently of call time', () => {
    for (const [join_period, days] of [
        ['day', 1],
        ['two_days', 2],
        ['week', 7],
        ['month', 30]
    ]) {
        const shoot = { status: 'open', join_period, join_started_at: 1000, call_time: null }
        const deadline = 1000 + days * 86400000
        assert.equal(joinDeadline(shoot), deadline)
        assert.equal(joiningAllowed(shoot, deadline - 1), true)
        assert.equal(joiningAllowed(shoot, deadline), false)
        assert.equal(joiningAllowed(shoot, deadline + 1), false)
    }
    assert.equal(
        joiningAllowed({ status: 'open', join_period: 'never', join_started_at: 1000 }, Number.MAX_SAFE_INTEGER),
        true
    )
    assert.equal(joiningAllowed({ status: 'closed', join_period: 'never', join_started_at: 1000 }), false)
})

test('forms from the previous deployment ask admins to reopen instead of partially updating', () => {
    assert.throws(
        () =>
            parseDetails({
                getTextInputValue: (key) => {
                    if (key === 'date') throw new Error('Unknown field')
                    return { name: 'Film', time: '2026-10-15 13:30', location: 'Studio' }[key]
                }
            }),
        /expired/
    )
})

test('removing Admin Team after opening setup prevents submitting the form', async (t) => {
    const f = await fixture(t)
    const organizer = f.members.get(IDS.extra)
    organizer.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    const setup = f.interaction({ command: 'setup', userId: organizer.id })
    await f.service.handleInteraction(setup)
    assert.ok(setup.modal)
    organizer.roles.cache.delete(IDS.adminRole)
    const submit = f.interaction({ customId: setup.modal.custom_id, userId: organizer.id })
    await f.service.handleInteraction(submit)
    assert.match(submit.replies.at(-1).content, /Admin Team role/)
    const shoot = await f.store.getShoot(setup.modal.custom_id.split(':')[3], IDS.guild)
    assert.equal(shoot.status, 'draft')
    assert.equal(shoot.channel_id, null)
})

test('setup checks the configured role ID and supports raw interaction member roles', async (t) => {
    const f = await fixture(t)
    const organizer = f.members.get(IDS.extra)
    organizer.roles.cache.set('100000000000000099', { id: '100000000000000099', name: 'Admin Team' })
    const denied = f.interaction({ command: 'setup', userId: organizer.id })
    await f.service.handleInteraction(denied)
    assert.equal(denied.modal, undefined)
    const allowed = f.interaction({ command: 'setup', userId: organizer.id })
    allowed.member = { roles: [IDS.adminRole] }
    await f.service.handleInteraction(allowed)
    assert.ok(allowed.replies[0].components)
    const token = allowed.replies[0].components[0].toJSON().components[0].custom_id
    const click = f.interaction({ customId: token, userId: organizer.id })
    click.member = { roles: [IDS.adminRole] }
    await f.service.handleInteraction(click)
    assert.ok(click.modal)
    const wrongGuild = f.interaction({ command: 'setup', userId: organizer.id })
    wrongGuild.member = { roles: [IDS.adminRole] }
    wrongGuild.guildId = '100000000000000098'
    await f.service.handleInteraction(wrongGuild)
    assert.equal(wrongGuild.modal, undefined)
    assert.equal(wrongGuild.replies.length, 0)
})
