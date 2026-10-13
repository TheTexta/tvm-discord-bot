// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Collection, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const { IDS, fixture, allows } = require('./helpers/shoot')

function removal(f, shoot, userId, actorId = IDS.admin) {
    const interaction = f.interaction({ command: 'remove', channelId: shoot.channel_id, userId: actorId })
    interaction.options.getUser = () => ({ id: userId })
    return interaction
}

async function assertRemoved(f, shoot, userId) {
    const row = (await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === userId)
    assert.equal(row.invited, 0)
    assert.equal(row.reacted, 0)
    assert.equal(row.reaction_message_id, null)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(userId), false)
}

test('shoot remove clears direct, reaction, and combined membership and permits fresh reaction rejoining', async (t) => {
    for (const kind of ['direct', 'reaction', 'combined']) {
        await t.test(kind, async (t) => {
            const f = await fixture(t)
            const { shoot } = await f.create()
            const name = kind === 'reaction' ? 'joined' : 'invited'
            const userId = IDS[name]
            let reaction
            if (kind !== 'direct') {
                reaction = await f.react(shoot, name)
                await f.react(shoot, name, true, { burst: true })
            }
            const member = f.members.get(userId)
            member.displayName = 'Removed crew member'
            const interaction = removal(f, shoot, userId)
            await f.service.handleInteraction(interaction)
            assert.match(interaction.replies.at(-1).content, /Removed/)
            assert.deepEqual(interaction.replies.at(-1).allowedMentions, { parse: [] })
            await assertRemoved(f, shoot, userId)
            if (reaction) {
                assert.equal(reaction.normal.has(userId), false)
                assert.equal(reaction.burst.has(userId), false)
            }
            const chat = f.channels.get(shoot.channel_id)
            const brief = chat.messages.cache.get(shoot.brief_id)
            assert.doesNotMatch(JSON.stringify(brief.embeds), /Removed crew member/)
            const crew = f.interaction({ command: 'crew', channelId: shoot.channel_id })
            await f.service.handleInteraction(crew)
            assert.equal(JSON.stringify(crew.replies.at(-1).embeds).includes(`<@${userId}>`), false)
            await f.restart()
            await f.service.reconcileAll()
            await assertRemoved(f, shoot, userId)
            await f.react(shoot, name, true, { burst: true })
            assert.ok(allows(chat, userId, P.ViewChannel))
            const rejoined = (await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === userId)
            assert.equal(rejoined.invited, 0, 'rejoining does not restore a direct invitation')
            assert.equal(rejoined.reacted, 1)
            assert.equal(f.errors.length, 0)
        })
    }
})

test('shoot remove is repeatable and absent participants remain absent', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    for (const userId of [IDS.invited, IDS.invited, IDS.extra, '100000000000000099']) {
        const interaction = removal(f, shoot, userId)
        await f.service.handleInteraction(interaction)
        assert.match(interaction.replies.at(-1).content, /Removed/)
    }
    await assertRemoved(f, shoot, IDS.invited)
    assert.equal((await f.store.shootParticipants(shoot.id)).length, 2)
    assert.equal(f.errors.length, 0)
})

test('shoot remove protects the organizer and rejects ordinary members, lookalike roles, bots, and wrong channels', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const protectedOrganizer = removal(f, shoot, IDS.admin)
    await f.service.handleInteraction(protectedOrganizer)
    assert.match(protectedOrganizer.replies.at(-1).content, /organizer cannot be removed/)
    f.members.get(IDS.outsider).roles.cache.set('fake-admin', { name: 'Admin Team' })
    for (const actorId of [IDS.invited, IDS.outsider, IDS.bot]) {
        const interaction = removal(f, shoot, IDS.invited, actorId)
        await f.service.handleInteraction(interaction)
        assert.match(interaction.replies.at(-1).content, /Admin Team role/)
        assert.equal(interaction.deferred, undefined)
    }
    const wrongChannel = f.interaction({ command: 'remove' })
    await f.service.handleInteraction(wrongChannel)
    assert.match(wrongChannel.replies.at(-1).content, /not a TVM-managed shoot/)
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.invited, P.ViewChannel))
    assert.equal(
        (await f.store.shootParticipants(shoot.id)).every((row) => row.invited),
        true
    )
})

test('shoot remove works in archived chats and prevents access returning on reopening', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    for (const userId of [IDS.invited, IDS.joined]) {
        const interaction = removal(f, shoot, userId)
        await f.service.handleInteraction(interaction)
        assert.match(interaction.replies.at(-1).content, /Removed/)
        await assertRemoved(f, shoot, userId)
    }
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'closed')
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    await f.service.reconcileAll()
    for (const userId of [IDS.invited, IDS.joined]) await assertRemoved(f, shoot, userId)
    assert.equal(f.errors.length, 0)
})

test('shoot remove rejects shoots whose status is still changing', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.store.updateShoot(shoot.id, { status: 'reopening' })
    const interaction = removal(f, shoot, IDS.invited)
    await f.service.handleInteraction(interaction)
    assert.match(interaction.replies.at(-1).content, /still being synchronized/)
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.invited).invited, 1)
})

test('shoot remove allows an Admin Team caller and explains retained admin visibility', async (t) => {
    for (const authority of ['role', 'administrator']) {
        await t.test(authority, async (t) => {
            const f = await fixture(t)
            const { shoot } = await f.create()
            const caller = f.members.get(IDS.outsider)
            caller.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
            const target = f.members.get(IDS.invited)
            if (authority === 'role') target.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
            else target.permissions = new PermissionsBitField(P.Administrator)
            await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
            const interaction = removal(f, shoot, target.id, caller.id)
            await f.service.handleInteraction(interaction)
            assert.match(interaction.replies.at(-1).content, /admin permissions still grant access/)
            await assertRemoved(f, shoot, target.id)
            assert.ok(allows(f.channels.get(shoot.channel_id), IDS.adminRole, P.ViewChannel))
            assert.equal(f.errors.length, 0)
        })
    }
})

test('shoot remove does not require eligibility or a current server membership', async (t) => {
    for (const departed of [false, true]) {
        await t.test(departed ? 'departed' : 'lost eligibility', async (t) => {
            const f = await fixture(t)
            const { shoot } = await f.create()
            if (departed) f.members.delete(IDS.invited)
            else f.members.get(IDS.invited).roles.cache.clear()
            const interaction = removal(f, shoot, IDS.invited)
            await f.service.handleInteraction(interaction)
            assert.match(interaction.replies.at(-1).content, /Removed/)
            await assertRemoved(f, shoot, IDS.invited)
            assert.equal(f.errors.length, 0)
        })
    }
})

test('removed members must meet the current joining window and eligibility, but admins can re-add them', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(removal(f, shoot, IDS.invited))
    const member = f.members.get(IDS.invited)
    member.roles.cache.clear()
    await f.react(shoot, 'invited')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(member.id), false)
    member.roles.cache.set(IDS.memberRole, { id: IDS.memberRole })
    await f.store.updateShoot(shoot.id, { join_started_at: Date.now() - 86400001 })
    await f.react(shoot, 'invited')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(member.id), false)
    const add = f.interaction({ command: 'add', channelId: shoot.channel_id, addUserId: member.id })
    await f.service.handleInteraction(add)
    assert.match(add.replies.at(-1).content, /Added/)
    assert.ok(allows(f.channels.get(shoot.channel_id), member.id, P.ViewChannel))
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === member.id).invited, 1)
})

test('shoot remove tolerates missing invitations and missing reactions', async (t) => {
    for (const missing of ['message', 'reaction', 10008, 10014]) {
        await t.test(String(missing), async (t) => {
            const f = await fixture(t)
            const { shoot } = await f.create()
            const announcement = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
            if (missing === 'message') f.channels.get(IDS.announce).messages.cache.delete(shoot.announcement_id)
            else if (missing === 'reaction') announcement.reactions.cache.delete('🎬')
            else
                announcement.reactions.cache.get('🎬').users.remove = async () => {
                    throw Object.assign(new Error('Reaction or message already gone'), { code: missing })
                }
            const interaction = removal(f, shoot, IDS.invited)
            await f.service.handleInteraction(interaction)
            assert.match(interaction.replies.at(-1).content, /Removed/)
            await assertRemoved(f, shoot, IDS.invited)
            assert.equal(f.errors.length, 0)
        })
    }
})

test('removal frees a seat while fresh reaction rejoining still respects the participant limit', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    for (let i = 0; i < 96; i++) {
        const id = String(100000000000000100n + BigInt(i))
        f.members.set(id, {
            id,
            user: { id, username: `crew-${i}`, bot: false },
            roles: { cache: new Collection([[IDS.memberRole, { id: IDS.memberRole }]]) },
            permissions: new PermissionsBitField(0n)
        })
        await f.store.inviteShootParticipant(shoot.id, id)
    }
    assert.equal((await f.service.participantIds(shoot, f.guild)).length, 98)
    await f.react(shoot, 'joined')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
    await f.service.handleInteraction(removal(f, shoot, IDS.invited))
    assert.equal((await f.service.participantIds(shoot, f.guild)).length, 97)
    await f.react(shoot, 'joined')
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.joined, P.ViewChannel))
    await f.react(shoot, 'invited')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.invited), false)
    assert.equal((await f.service.participantIds(shoot, f.guild)).length, 98)
    assert.equal(f.errors.length, 0)
})

test('reaction cleanup failure aborts before changing membership and permits a safe retry', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'invited')
    const original = reaction.users.remove
    reaction.users.remove = async () => {
        throw Object.assign(new Error('Missing Manage Messages'), { code: 50013 })
    }
    const before = (await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.invited)
    const interaction = removal(f, shoot, IDS.invited)
    await f.service.handleInteraction(interaction)
    assert.match(interaction.replies.at(-1).content, /Missing Manage Messages/)
    assert.deepEqual(
        (await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.invited),
        before
    )
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.invited, P.ViewChannel))
    assert.ok(reaction.normal.has(IDS.invited))
    reaction.users.remove = original
    await f.service.handleInteraction(removal(f, shoot, IDS.invited))
    await assertRemoved(f, shoot, IDS.invited)
})

test('shoot removal persists through a failed channel edit and reconciliation retries revocation after restart', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'invited')
    const chat = f.channels.get(shoot.channel_id)
    chat.failEdit = true
    const interaction = removal(f, shoot, IDS.invited)
    await f.service.handleInteraction(interaction)
    assert.doesNotMatch(interaction.replies.at(-1).content, /^Removed/)
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.invited).invited, 0)
    assert.ok(allows(chat, IDS.invited, P.ViewChannel), 'failed edit has not revoked Discord access yet')
    await f.restart()
    await f.service.reconcileAll()
    await assertRemoved(f, shoot, IDS.invited)
})

test('removal serializes with queued reaction reconciliation so old events cannot restore membership', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'invited')
    await Promise.all([
        f.service.handleInteraction(removal(f, shoot, IDS.invited)),
        f.service.onReaction(reaction, f.members.get(IDS.invited).user)
    ])
    await assertRemoved(f, shoot, IDS.invited)
    assert.equal(reaction.normal.has(IDS.invited), false)
    assert.equal(f.errors.length, 0)
})
