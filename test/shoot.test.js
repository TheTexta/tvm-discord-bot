// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Collection, Embed, ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const Store = require('../src/tvm/Store')
const { loadShootConfig } = require('../src/tvm/config')
const { ShootService, shootCommand, parseMembers, parseDetails, overwrites, joinDeadline, joiningAllowed, BOT_PERMISSIONS } = require('../src/tvm/ShootService')

const IDS = {
    guild: '100000000000000001', bot: '100000000000000002', admin: '100000000000000003',
    invited: '100000000000000004', joined: '100000000000000005', outsider: '100000000000000006',
    announce: '100000000000000007', active: '100000000000000008', archive: '100000000000000009',
    other: '100000000000000010', extra: '100000000000000011', adminRole: '100000000000000012'
}
const fields = (name = 'TVM film', value = '2026-10-15 13:30', location = 'Studio', period = 'day') => {
    const [date = '', time = ''] = value.split(' ')
    return { getTextInputValue: key => ({ name, date, time, location })[key], getStringSelectValues: () => [period] }
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-shoot-'))
    const filename = path.join(dir, 'tvm.db')
    let store = new Store(filename, 's'.repeat(32))
    await store.ready
    t.after(async () => { service.stop(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    await store.replaceRoster(IDS.guild, ['invited', 'joined', 'extra'].map(name => ({ email: `${name}@example.org`, role: 'gm' })), IDS.admin)
    for (const name of ['invited', 'joined', 'extra']) {
        await store.savePending(IDS.guild, IDS[name], `${name}@example.org`, '123456')
        assert.equal((await store.verifyAndClaim(IDS.guild, IDS[name], '123456')).ok, true)
    }
    const channels = new Collection()
    const members = new Collection()
    const notices = []
    const errors = []
    let sequence = 500000000000000000n
    const nextId = () => String(++sequence)
    const restEmbeds = embeds => (embeds || []).map(embed => {
        const data = embed.toJSON()
        return new Embed({ ...data, type: 'rich', fields: data.fields?.map(field => ({ ...field, inline: Boolean(field.inline) })) })
    })
    for (const [name, id] of Object.entries(IDS)) {
        if (!['bot', 'admin', 'invited', 'joined', 'outsider', 'extra'].includes(name)) continue
        const user = { id, username: name, bot: name === 'bot', send: async payload => { notices.push({ id, payload }) } }
        const member = { id, user, roles: { cache: new Collection() }, permissions: new PermissionsBitField(name === 'admin' || name === 'bot' ? P.Administrator : 0n) }
        members.set(id, member)
    }
    function channel(id, type = ChannelType.GuildText, options = {}) {
        const messages = new Collection()
        const object = {
            id, guildId: IDS.guild, type, parentId: options.parent || null, topic: options.topic,
            permissionOverwrites: { cache: new Collection() },
            permissions: new PermissionsBitField(P.Administrator),
            permissionsFor: () => object.permissions,
            edits: [], sends: [],
            edit: async options => {
                if (object.failEdit) { object.failEdit = false; throw new Error('permission failure') }
                object.edits.push(options)
                if (options.parent) object.parentId = options.parent
                if (options.permissionOverwrites) {
                    object.permissionOverwrites.cache = new Collection(options.permissionOverwrites.map(entry => [entry.id,
                        { ...entry, allow: new PermissionsBitField(entry.allow), deny: new PermissionsBitField(entry.deny) }]))
                }
                return object
            },
            messages: { cache: messages, delete: async id => {
                if (object.failDelete) { object.failDelete = false; throw new Error('announcement deletion failed') }
                if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 })
                messages.delete(id)
                if (object.failDeleteAfter) { object.failDeleteAfter = false; throw new Error('delete response lost') }
            }, fetch: async input => {
                if (typeof input === 'string' || input.message) {
                    const id = typeof input === 'string' ? input : input.message
                    assert.equal(input.force, true, 'stored messages must bypass cached reaction state')
                    if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 })
                    return messages.get(id)
                }
                return new Collection([...messages].sort((a, b) => b[0].localeCompare(a[0]))
                    .filter(([id]) => !input.before || id < input.before).slice(0, input.limit))
            } },
            send: async payload => {
                const existing = [...messages.values()].find(message => message.nonce === payload.nonce)
                if (payload.enforceNonce && existing) return existing
                object.sends.push(payload)
                const message = {
                    id: nextId(), channelId: id, guildId: IDS.guild, author: members.get(IDS.bot).user,
                    embeds: restEmbeds(payload.embeds), content: payload.content || '', nonce: payload.nonce, pinned: false, createdTimestamp: Date.now(),
                    reactions: { cache: new Collection() }, edits: [],
                    edit: async payload => { message.edits.push(payload); message.embeds = restEmbeds(payload.embeds); message.content = payload.content; return message },
                    pin: async () => { message.pinned = true },
                    react: async emoji => {
                        const reaction = addReaction(message, emoji)
                        reaction.me = true
                        reaction.normal.set(IDS.bot, members.get(IDS.bot).user)
                        return reaction
                    }
                }
                messages.set(message.id, message)
                if (object.failSendAfter) { object.failSendAfter = false; throw new Error('send response lost') }
                return message
            }
        }
        channels.set(id, object)
        if (options.permissionOverwrites) awaitableOverwrites(object, options.permissionOverwrites)
        return object
    }
    function awaitableOverwrites(object, entries) {
        object.permissionOverwrites.cache = new Collection(entries.map(entry => [entry.id,
            { ...entry, allow: new PermissionsBitField(entry.allow), deny: new PermissionsBitField(entry.deny) }]))
    }
    function addReaction(message, emoji = '🎬') {
        if (message.reactions.cache.has(emoji)) return message.reactions.cache.get(emoji)
        const reaction = {
            message, emoji: { id: null, name: emoji }, me: false,
            normal: new Collection(), burst: new Collection(), pages: [],
            users: {
                fetch: async options => {
                    reaction.pages.push(options)
                    const users = options.type ? reaction.burst : reaction.normal
                    return new Collection([...users].sort((a, b) => a[0].localeCompare(b[0]))
                        .filter(([id]) => !options.after || id > options.after).slice(0, options.limit))
                },
                remove: async id => { reaction.normal.delete(id); reaction.burst.delete(id) }
            }
        }
        message.reactions.cache.set(emoji, reaction)
        return reaction
    }
    channel(IDS.announce)
    channel(IDS.active, ChannelType.GuildCategory)
    channel(IDS.archive, ChannelType.GuildCategory)
    channel(IDS.other)
    const guild = {
        id: IDS.guild,
        members: { fetchMe: async () => members.get(IDS.bot), fetch: async input => {
            const id = typeof input === 'string' ? input : input.user
            if (!members.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 })
            return members.get(id)
        } },
        channels: {
            fetch: async id => {
                if (!id) return channels
                if (!channels.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 })
                return channels.get(id)
            },
            create: async options => {
                const result = channel(nextId(), options.type, options)
                if (guild.failCreateAfter) { guild.failCreateAfter = false; throw new Error('channel response lost') }
                return result
            }
        }
    }
    const client = { user: members.get(IDS.bot).user, guilds: { fetch: async () => guild } }
    const config = { guildId: IDS.guild, adminRoleId: IDS.adminRole, shoots: { announcementChannelId: IDS.announce, categoryId: IDS.active, archiveCategoryId: IDS.archive } }
    const service = new ShootService({ client, store, config, alertAdmins: async message => errors.push(message) })
    service.report = async (id, error) => { errors.push({ id, error: error.message }) }
    function interaction({ command = null, customId = null, channelId = IDS.other, userId = IDS.admin, mentions = '', addUserId = IDS.extra } = {}) {
        return {
            guild, guildId: IDS.guild, channelId, channel: channels.get(channelId), user: members.get(userId).user,
            memberPermissions: members.get(userId).permissions, member: members.get(userId),
            commandName: command ? 'shoot' : null, customId,
            options: { getSubcommand: () => command, getString: () => mentions, getUser: () => members.get(addUserId).user }, fields: fields(),
            isChatInputCommand: () => Boolean(command), isModalSubmit: () => Boolean(customId),
            replies: [],
            reply: async function(payload) { this.replied = true; this.replies.push(payload) },
            editReply: async function(payload) { this.replies.push(payload) },
            deferReply: async function() { this.deferred = true },
            showModal: async function(modal) { this.modal = modal.toJSON(); this.replied = true }
        }
    }
    async function create(details = fields()) {
        const setup = interaction({ command: 'setup', mentions: `<@${IDS.invited}>` })
        await service.handleInteraction(setup)
        assert.ok(setup.modal)
        const submit = interaction({ customId: setup.modal.custom_id })
        submit.fields = details
        await service.handleInteraction(submit)
        const id = setup.modal.custom_id.split(':')[3]
        return { setup, submit, id, shoot: await store.getShoot(id, IDS.guild) }
    }
    async function react(shoot, name, add = true, { burst = false, emoji = '🎬', event = true } = {}) {
        const message = channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
        const reaction = addReaction(message, emoji)
        const collection = burst ? reaction.burst : reaction.normal
        const user = members.get(IDS[name]).user
        if (add) collection.set(user.id, user)
        else collection.delete(user.id)
        if (event) {
            // Deliberately uncached/partial event: only identifiers are available.
            await service.onReaction({ emoji: reaction.emoji, partial: true,
                message: { id: message.id, guildId: IDS.guild, channelId: IDS.announce, partial: true } }, user)
        }
        return reaction
    }
    return { get store() { return store }, service, guild, config, client, channels, members, notices, errors,
        interaction, create, react, channel, addReaction,
        restart: async () => { await store.close(); store = new Store(filename, 's'.repeat(32)); await store.ready; service.store = store } }
}

function allows(channel, userId, flag) {
    const overwrite = channel.permissionOverwrites.cache.get(userId)
    return Boolean(overwrite?.allow.has(flag))
}

// These tests exercise real SQLite persistence and a Discord adapter that can lose successful responses.
test('shoot configuration is optional, complete, distinct, and validates snowflakes', () => {
    assert.equal(loadShootConfig({}), null)
    assert.throws(() => loadShootConfig({ TVM_SHOOT_CATEGORY_ID: IDS.active }))
    const env = { TVM_SHOOT_ANNOUNCEMENT_CHANNEL_ID: IDS.announce, TVM_SHOOT_CATEGORY_ID: IDS.active,
        TVM_SHOOT_ARCHIVE_CATEGORY_ID: IDS.archive }
    assert.equal(loadShootConfig(env).categoryId, IDS.active)
    assert.throws(() => loadShootConfig({ ...env, TVM_SHOOT_ARCHIVE_CATEGORY_ID: IDS.active }))
    assert.throws(() => loadShootConfig({ ...env, TVM_SHOOT_CATEGORY_ID: 'bad' }))
    const command = shootCommand()
    assert.equal(command.default_member_permissions, null)
    assert.deepEqual(command.options.map(option => option.name), ['setup', 'edit', 'crew', 'add', 'close', 'reopen'])
})

test('validates mention input and Toronto calendar/DST times', () => {
    assert.deepEqual(parseMembers(`<@${IDS.invited}>, <@!${IDS.joined}> <@${IDS.invited}>`), [IDS.invited, IDS.joined])
    assert.deepEqual(parseMembers(''), [])
    for (const input of ['@everyone', 'Alice', `<@&${IDS.invited}>`, '<@123>', `<@${IDS.joined}> unwanted`]) assert.throws(() => parseMembers(input))
    assert.equal(parseDetails(fields()).call_time, Date.parse('2026-10-15T17:30:00Z'))
    for (const time of ['2026-02-30 10:00', '2026-03-08 02:30', '2026-11-01 01:30', '2026-10-15 25:00', '2026-10-5 13:30']) {
        assert.throws(() => parseDetails(fields('Shoot', time)))
    }
    assert.equal(parseDetails(fields('Shoot', '2026-12-15 13:30')).call_time, Date.parse('2026-12-15T18:30:00Z'))
    assert.throws(() => parseDetails(fields('', '2026-10-15 13:30')))
})

test('setup creates one private chat, pinned brief, invitation, and immutable invitations', async t => {
    const f = await fixture(t)
    const { shoot, submit } = await f.create()
    assert.equal(shoot.status, 'open')
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.parentId, IDS.active)
    assert.equal(allows(chat, IDS.invited, P.SendMessages), true)
    assert.equal(allows(chat, IDS.admin, P.ViewChannel), true)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    assert.ok(chat.permissionOverwrites.cache.get(IDS.guild).deny.has(P.ViewChannel))
    assert.ok(chat.permissionOverwrites.cache.get(IDS.invited).deny.has(P.CreatePublicThreads))
    assert.equal(chat.messages.cache.get(shoot.brief_id).pinned, true)
    assert.deepEqual(f.channels.get(IDS.announce).sends[0].allowedMentions, { parse: [] })
    assert.ok(submit.replies.at(-1).content.includes(shoot.channel_id))
    const invitation = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    assert.ok(invitation.reactions.cache.get('🎬').me)
    await f.store.setShootReaction(shoot.id, IDS.invited, true, shoot.announcement_id)
    await f.store.setShootReaction(shoot.id, IDS.invited, false, shoot.announcement_id)
    assert.equal((await f.store.shootParticipants(shoot.id)).find(row => row.user_id === IDS.invited).invited, 1)
})

test('command and modal permissions are checked independently; invalid invites cannot provision', async t => {
    const f = await fixture(t)
    const denied = f.interaction({ command: 'setup', userId: IDS.invited })
    await f.service.handleInteraction(denied)
    assert.equal(denied.modal, undefined)
    const setup = f.interaction({ command: 'setup', mentions: `<@${IDS.outsider}>` })
    await f.service.handleInteraction(setup)
    const lostPermission = f.interaction({ customId: setup.modal.custom_id, userId: IDS.invited })
    await f.service.handleInteraction(lostPermission)
    const submit = f.interaction({ customId: setup.modal.custom_id })
    await f.service.handleInteraction(submit)
    const shoot = await f.store.getShoot(setup.modal.custom_id.split(':')[3], IDS.guild)
    assert.equal(shoot.status, 'draft')
    assert.equal(shoot.channel_id, null)
    assert.ok(submit.replies.at(-1).content.includes('verified'))
})

test('partial, duplicate, and concurrent reaction events join once and preserve direct invitations', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'joined')
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    await Promise.all([f.service.onReaction(reaction, f.members.get(IDS.joined).user), f.service.onReaction(reaction, f.members.get(IDS.joined).user)])
    assert.equal((await f.store.shootParticipants(shoot.id)).filter(row => row.user_id === IDS.joined).length, 1)
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    await f.react(shoot, 'invited')
    await f.react(shoot, 'invited', false)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    await f.react(shoot, 'outsider')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    assert.equal(reaction.normal.has(IDS.outsider), false)
    assert.equal(f.notices.length, 1)
    await f.react(shoot, 'joined', true, { emoji: '👍' })
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('normal and super reactions retain membership until both are removed', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.react(shoot, 'joined', true, { burst: true })
    await f.react(shoot, 'joined', false)
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.joined, P.ViewChannel))
    await f.react(shoot, 'joined', false, { burst: true })
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
})

test('close creates a read-only archive, blocks new joins, allows withdrawal, and reopens', async t => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    await f.react(shoot, 'joined')
    const close = f.interaction({ command: 'close', channelId: shoot.channel_id })
    await f.service.handleInteraction(close)
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(shoot.status, 'closed')
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.parentId, IDS.archive)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    for (const flag of [P.SendMessages, P.SendMessagesInThreads, P.AddReactions, P.CreatePrivateThreads]) {
        assert.ok(chat.permissionOverwrites.cache.get(IDS.joined).deny.has(flag))
    }
    await f.react(shoot, 'extra')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.invited, P.ViewChannel))
    const reopen = f.interaction({ command: 'reopen', channelId: shoot.channel_id })
    await f.service.handleInteraction(reopen)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'open')
    assert.equal(chat.parentId, IDS.active)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    await f.react(shoot, 'extra')
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
})

test('edit updates both messages without notifications and rejects stale forms; crew is private', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('New name', '2026-12-01 09:00', 'Outside')
    await f.service.handleInteraction(submit)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).name, 'New name')
    for (const [channelId, messageId] of [[shoot.channel_id, shoot.brief_id], [IDS.announce, shoot.announcement_id]]) {
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

test('restart persists state and catches offline joins, leaves, and bulk reaction removal', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.react(shoot, 'joined', false, { event: false })
    await f.react(shoot, 'extra', true, { event: false })
    await f.restart()
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    message.reactions.cache.clear()
    await f.service.onReactionClear(message)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    assert.ok(allows(chat, IDS.invited, P.SendMessages))
    assert.ok(message.reactions.cache.get('🎬').me)
})

test('lost channel and announcement responses recover resources without duplicates or repeated pings', async t => {
    const f = await fixture(t)
    f.guild.failCreateAfter = true
    const { shoot, id } = await f.create()
    assert.equal(shoot.status, 'provisioning')
    assert.equal(shoot.channel_id, null)
    const created = f.channels.size
    await f.restart()
    f.channels.get(IDS.announce).failSendAfter = true
    await f.service.reconcileAll()
    assert.equal(f.channels.size, created)
    assert.equal((await f.store.getShoot(id, IDS.guild)).announcement_id, null)
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    // Expire the nonce so recovery must use the durable marker, not recent-send deduplication.
    for (const message of f.channels.get(IDS.announce).messages.cache.values()) message.nonce = null
    await f.restart()
    await f.service.reconcileAll()
    const recovered = await f.store.getShoot(id, IDS.guild)
    assert.equal(recovered.status, 'open')
    assert.ok(recovered.brief_id && recovered.announcement_id)
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.equal(f.channels.get(recovered.channel_id).sends.length, 1)
    assert.ok(f.errors.length >= 2)
})

test('failed close stays durable and retries without exposing inherited category permissions', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const chat = f.channels.get(shoot.channel_id)
    chat.failEdit = true
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'closing')
    await f.restart()
    await f.service.reconcileAll()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'closed')
    assert.equal(chat.parentId, IDS.archive)
    assert.equal(chat.edits.at(-1).lockPermissions, false)
    assert.equal(allows(chat, IDS.invited, P.SendMessages), false)
})

test('deleted briefs recover, announcements remain deleted, and a deleted chat is never recreated', async t => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    await f.react(shoot, 'joined')
    const chat = f.channels.get(shoot.channel_id)
    chat.messages.cache.delete(shoot.brief_id)
    f.channels.get(IDS.announce).messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    await f.service.reconcileAll()
    const recovered = await f.store.getShoot(shoot.id, IDS.guild)
    assert.notEqual(recovered.brief_id, shoot.brief_id)
    assert.equal(recovered.announcement_id, shoot.announcement_id)
    assert.ok(recovered.announcement_deleted_at)
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    assert.deepEqual(f.channels.get(IDS.announce).sends.at(-1).allowedMentions, { parse: [] })
    shoot = recovered
    await f.restart()
    await f.service.reconcileAll()
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    f.channels.delete(shoot.channel_id)
    const count = f.channels.size
    await f.service.reconcileAll()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'missing')
    await f.service.reconcileAll()
    assert.equal(f.channels.size, count)
    assert.ok(f.errors.length)
})

test('reconciliation removes access after verification is revoked; organizer access persists', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.store.releaseClaim(IDS.guild, 'joined@example.org', IDS.admin)
    await f.store.releaseClaim(IDS.guild, 'invited@example.org', IDS.admin)
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.invited), false)
    assert.ok(allows(chat, IDS.admin, P.ViewChannel))
})

test('reaction pagination includes every normal and super reaction page', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const reaction = message.reactions.cache.get('🎬')
    for (let i = 0; i < 230; i++) {
        const id = String(600000000000000000n + BigInt(i))
        reaction.normal.set(id, { id, bot: false })
    }
    reaction.burst.set(IDS.extra, f.members.get(IDS.extra).user)
    const users = await f.service.reactionUsers(message)
    assert.equal(users.size, 231)
    assert.equal(reaction.pages.filter(options => options.type === 0).length, 3)
    assert.ok(users.has(IDS.extra))
})

test('initialization validates category type and bot permissions', async t => {
    const f = await fixture(t)
    f.channels.get(IDS.active).permissions = new PermissionsBitField(0n)
    await assert.rejects(f.service.initialize(), /permissions/)
    f.channels.get(IDS.active).permissions = new PermissionsBitField(BOT_PERMISSIONS)
    f.channels.get(IDS.archive).type = ChannelType.GuildText
    await assert.rejects(f.service.initialize(), /configuration/)
})

test('unchanged REST embeds are not repeatedly edited during reconciliation', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.reconcileAll()
    await f.service.reconcileAll()
    assert.equal(f.channels.get(shoot.channel_id).messages.cache.get(shoot.brief_id).edits.length, 1)
    assert.equal(f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).edits.length, 1)
})

test('closed offline join attempts are rejected before reopening', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const reaction = await f.react(shoot, 'extra', true, { event: false })
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    assert.equal(reaction.normal.has(IDS.extra), false)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.extra), false)
})

test('grant failure is retried durably; a failed leave is retried to revoke access', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const chat = f.channels.get(shoot.channel_id)
    chat.failEdit = true
    await f.react(shoot, 'joined')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal((await f.store.shootParticipants(shoot.id)).find(row => row.user_id === IDS.joined).reacted, 1)
    await f.restart()
    await f.service.reconcileAll()
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    chat.failEdit = true
    await f.react(shoot, 'joined', false)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    await f.service.reconcileAll()
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('expired, cross-channel, invalid-time, and replayed setup forms cannot create additional chats', async t => {
    const f = await fixture(t)
    const setup = f.interaction({ command: 'setup' })
    await f.service.handleInteraction(setup)
    const id = setup.modal.custom_id.split(':')[3]
    await f.store._locked(() => f.store._run('UPDATE shoots SET created_at = ? WHERE id = ?', [Date.now() - 31 * 60000, id]))
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

test('bots and unrelated announcement messages cannot enroll participants', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'bot')
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.bot), true)
    assert.equal((await f.store.shootParticipants(shoot.id)).some(row => row.user_id === IDS.bot), false)
    await f.service.onReaction({ emoji: { id: null, name: '🎬' },
        message: { id: '999999999999999999', guildId: IDS.guild, channelId: IDS.announce } }, f.members.get(IDS.joined).user)
    assert.equal((await f.store.shootParticipants(shoot.id)).some(row => row.user_id === IDS.joined), false)
})

test('participant capacity rejects excess joins without breaking existing access', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const message = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const reaction = message.reactions.cache.get('🎬')
    const rows = Array.from({ length: 96 }, (_, i) => ({ email: `crew${i}@example.org`, role: 'gm' }))
    await f.store.mergeRoster(IDS.guild, rows, IDS.admin)
    for (let i = 0; i < rows.length; i++) {
        const id = String(700000000000000000n + BigInt(i))
        const user = { id, bot: false, send: async () => {} }
        f.members.set(id, { id, user, permissions: new PermissionsBitField(0n) })
        await f.store.savePending(IDS.guild, id, rows[i].email, '123456')
        assert.equal((await f.store.verifyAndClaim(IDS.guild, id, '123456')).ok, true)
        reaction.normal.set(id, user)
    }
    await f.service.reconcileAll()
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.permissionOverwrites.cache.size, 101) // 98 participants, bot, @everyone, Admin Team.
    await f.react(shoot, 'joined')
    assert.equal(reaction.normal.has(IDS.joined), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    assert.ok(allows(chat, IDS.invited, P.ViewChannel))
    assert.equal(f.errors.length, 0)
})

test('failed reaction cleanup cannot prevent revoking an ineligible member', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const reaction = await f.react(shoot, 'joined')
    await f.store.releaseClaim(IDS.guild, 'joined@example.org', IDS.admin)
    reaction.users.remove = async () => { throw new Error('missing Manage Messages') }
    await f.service.reconcileAll()
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
    assert.equal((await f.store.shootParticipants(shoot.id)).find(row => row.user_id === IDS.joined).reacted, 0)
    assert.ok(f.errors.some(error => error.error.includes('Manage Messages')))
})

test('setup modal separates optional date/time and defaults its joining dropdown to one day', async t => {
    const f = await fixture(t)
    const { setup, shoot } = await f.create()
    assert.equal(setup.modal.components.length, 5)
    const components = setup.modal.components.map(label => label.component)
    assert.deepEqual(components.slice(0, 4).map(component => component.custom_id), ['name', 'date', 'time', 'location'])
    assert.equal(components[1].required, false)
    assert.equal(components[2].required, false)
    const select = components[4]
    assert.equal(select.type, 3)
    assert.equal(select.custom_id, 'join_period')
    assert.deepEqual(select.options.map(option => option.value), ['day', 'two_days', 'week', 'month', 'never'])
    assert.deepEqual(select.options.filter(option => option.default).map(option => option.value), ['day'])
    assert.equal(joinDeadline(shoot), shoot.join_started_at + 86400000)
    assert.equal(shoot.join_started_at, f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).createdTimestamp)
})

test('blank time means Toronto noon and blank date means no scheduled timestamp', async t => {
    assert.equal(parseDetails(fields('Shoot', '2026-10-15')).call_time, Date.parse('2026-10-15T16:00:00Z'))
    assert.equal(parseDetails(fields('Shoot', '2026-12-15')).call_time, Date.parse('2026-12-15T17:00:00Z'))
    assert.equal(parseDetails(fields('Shoot', '')).call_time, null)
    assert.equal(parseDetails(fields('Shoot', ' 09:30')).call_time, null)
    for (const period of ['day', 'two_days', 'week', 'month', 'never']) assert.equal(parseDetails(fields('Shoot', '', 'Studio', period)).join_period, period)
    assert.throws(() => parseDetails(fields('Shoot', '', 'Studio', 'invalid')), /Choose/)
    assert.throws(() => parseDetails({ ...fields(), getStringSelectValues: () => [] }), /Choose/)
    const f = await fixture(t)
    const { shoot } = await f.create(fields('Undated shoot', ''))
    assert.equal(shoot.call_time, null)
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(chat.messages.cache.get(shoot.brief_id).embeds[0].fields[0].value, 'Unscheduled')
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const inputs = edit.modal.components.map(label => label.component)
    assert.equal(inputs[1].value, undefined)
    assert.equal(inputs[2].value, undefined)
})

test('joining periods use elapsed days and enforce the exact expiry boundary independently of call time', () => {
    for (const [join_period, days] of [['day', 1], ['two_days', 2], ['week', 7], ['month', 30]]) {
        const shoot = { status: 'open', join_period, join_started_at: 1000, call_time: null }
        const deadline = 1000 + days * 86400000
        assert.equal(joinDeadline(shoot), deadline)
        assert.equal(joiningAllowed(shoot, deadline - 1), true)
        assert.equal(joiningAllowed(shoot, deadline), false)
        assert.equal(joiningAllowed(shoot, deadline + 1), false)
    }
    assert.equal(joiningAllowed({ status: 'open', join_period: 'never', join_started_at: 1000 }, Number.MAX_SAFE_INTEGER), true)
    assert.equal(joiningAllowed({ status: 'closed', join_period: 'never', join_started_at: 1000 }), false)
})

test('expiry keeps the chat and members open, rejects new joins, and permits admin additions', async t => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.store.updateShoot(shoot.id, { join_started_at: Date.now() - 86400001 })
    await f.restart()
    await f.service.reconcileAll()
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    const chat = f.channels.get(shoot.channel_id)
    assert.equal(shoot.status, 'open')
    assert.equal(chat.parentId, IDS.active)
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    const reaction = await f.react(shoot, 'extra')
    assert.equal(reaction.normal.has(IDS.extra), false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    assert.match(f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).content, /expired/)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id, userId: IDS.invited }))
    assert.equal(chat.permissionOverwrites.cache.has(IDS.extra), false)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id, addUserId: IDS.outsider }))
    assert.equal(chat.permissionOverwrites.cache.has(IDS.outsider), false)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    await f.react(shoot, 'extra')
    await f.react(shoot, 'extra', false)
    assert.ok(allows(chat, IDS.extra, P.SendMessages))
    await f.react(shoot, 'joined', false)
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
    await f.react(shoot, 'joined')
    assert.equal(chat.permissionOverwrites.cache.has(IDS.joined), false)
})

test('editing can extend joining or choose never; reopening and message recovery do not reset the clock', async t => {
    const f = await fixture(t)
    let { shoot } = await f.create()
    const start = Date.now() - 36 * 3600000
    await f.store.updateShoot(shoot.id, { join_started_at: start })
    await f.service.reconcileAll()
    let edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    let submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('Film', '', 'Studio', 'two_days')
    await f.service.handleInteraction(submit)
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(shoot.join_started_at, start)
    assert.equal(shoot.call_time, null)
    assert.equal(joiningAllowed(shoot), true)
    const currentEdit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(currentEdit)
    assert.equal(currentEdit.modal.components[4].component.options.find(option => option.default).value, 'two_days')
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).join_started_at, start)
    f.channels.get(IDS.announce).messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).join_started_at, start)
    edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('Film', '', 'Studio', 'never')
    await f.service.handleInteraction(submit)
    assert.equal(joinDeadline(await f.store.getShoot(shoot.id, IDS.guild)), null)
})

test('existing databases migrate with unlimited joining and preserve shoot details and members', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.store._locked(() => f.store._exec('ALTER TABLE shoots DROP COLUMN join_period; ALTER TABLE shoots DROP COLUMN join_started_at;'))
    await f.restart()
    const migrated = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(migrated.join_period, 'never')
    assert.equal(migrated.join_started_at, null)
    assert.equal(migrated.call_time, shoot.call_time)
    assert.equal(migrated.channel_id, shoot.channel_id)
    assert.ok((await f.store.shootParticipants(shoot.id)).some(row => row.user_id === IDS.invited && row.invited))
    await f.service.reconcileAll()
    assert.equal(joinDeadline(await f.store.getShoot(shoot.id, IDS.guild)), null)
})

test('forms from the previous deployment ask admins to reopen instead of partially updating', () => {
    assert.throws(() => parseDetails({ getTextInputValue: key => {
        if (key === 'date') throw new Error('Unknown field')
        return { name: 'Film', time: '2026-10-15 13:30', location: 'Studio' }[key]
    } }), /expired/)
})

test('Admin Team can use every shoot control without Administrator or a roster claim', async t => {
    const f = await fixture(t)
    const organizer = f.members.get(IDS.outsider)
    organizer.roles.cache.set(IDS.adminRole, { id: IDS.adminRole, name: 'Admin Team' })
    assert.equal(organizer.permissions.has(P.Administrator), false)
    assert.equal(await f.store.isAuthorizedUser(IDS.guild, organizer.id), false)
    const setup = f.interaction({ command: 'setup', userId: organizer.id })
    await f.service.handleInteraction(setup)
    assert.ok(setup.modal)
    const submit = f.interaction({ customId: setup.modal.custom_id, userId: organizer.id })
    await f.service.handleInteraction(submit)
    let shoot = await f.store.getShoot(setup.modal.custom_id.split(':')[3], IDS.guild)
    assert.equal(shoot.status, 'open')
    assert.equal(shoot.organizer_id, organizer.id)
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, organizer.id, P.SendMessages))
    assert.ok(allows(chat, IDS.adminRole, P.ViewChannel))
    assert.ok(allows(chat, IDS.adminRole, P.UseApplicationCommands))
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id, userId: organizer.id })
    await f.service.handleInteraction(edit)
    const editSubmit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id, userId: organizer.id })
    editSubmit.fields = fields('Updated shoot')
    await f.service.handleInteraction(editSubmit)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).name, 'Updated shoot')
    for (const command of ['crew', 'add', 'close']) {
        const control = f.interaction({ command, channelId: shoot.channel_id, userId: organizer.id })
        await f.service.handleInteraction(control)
        assert.equal(control.deferred, true)
    }
    shoot = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(shoot.status, 'closed')
    assert.ok(allows(chat, organizer.id, P.SendMessages))
    assert.ok(allows(chat, IDS.adminRole, P.SendMessages))
    assert.equal(allows(chat, IDS.extra, P.SendMessages), false)
    const reopen = f.interaction({ command: 'reopen', channelId: shoot.channel_id, userId: organizer.id })
    await f.service.handleInteraction(reopen)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'open')
    assert.equal(f.errors.length, 0)
})

test('Admin Team can manage another organizer’s archived shoot and lose authority when the role is removed', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const admin = f.members.get(IDS.outsider)
    admin.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    await f.react(shoot, 'outsider')
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id, userId: admin.id }))
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, admin.id, P.SendMessages))
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id, userId: admin.id })
    await f.service.handleInteraction(edit)
    assert.ok(edit.modal)
    admin.roles.cache.delete(IDS.adminRole)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id, userId: admin.id })
    await f.service.handleInteraction(submit)
    assert.match(submit.replies.at(-1).content, /Admin Team role/)
    await f.service.reconcileAll()
    assert.equal(chat.permissionOverwrites.cache.has(admin.id), false)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'closed')
})

test('removing Admin Team after opening setup prevents submitting the form', async t => {
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

test('setup checks the configured role ID and supports raw interaction member roles', async t => {
    const f = await fixture(t)
    const organizer = f.members.get(IDS.extra)
    organizer.roles.cache.set('100000000000000099', { id: '100000000000000099', name: 'Admin Team' })
    const denied = f.interaction({ command: 'setup', userId: organizer.id })
    await f.service.handleInteraction(denied)
    assert.equal(denied.modal, undefined)
    const allowed = f.interaction({ command: 'setup', userId: organizer.id })
    allowed.member = { roles: [IDS.adminRole] }
    await f.service.handleInteraction(allowed)
    assert.ok(allowed.modal)
    const wrongGuild = f.interaction({ command: 'setup', userId: organizer.id })
    wrongGuild.member = { roles: [IDS.adminRole] }
    wrongGuild.guildId = '100000000000000098'
    await f.service.handleInteraction(wrongGuild)
    assert.equal(wrongGuild.modal, undefined)
    assert.equal(wrongGuild.replies.length, 0)
})


test('removing Admin Team from a verified archived participant restores read-only access', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const participant = f.members.get(IDS.invited)
    participant.roles.cache.set(IDS.adminRole, { id: IDS.adminRole })
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, participant.id, P.SendMessages))
    participant.roles.cache.delete(IDS.adminRole)
    await f.service.reconcileAll()
    assert.ok(allows(chat, participant.id, P.ViewChannel))
    assert.equal(allows(chat, participant.id, P.SendMessages), false)
    assert.ok(chat.permissionOverwrites.cache.get(participant.id).deny.has(P.SendMessages))
})

test('direct invitations are names only in the private brief and never appear in announcements', async t => {
    const f = await fixture(t)
    f.members.get(IDS.invited).displayName = 'Owen (Executive Producer)'
    const { shoot } = await f.create()
    const announcement = f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id)
    const brief = f.channels.get(shoot.channel_id).messages.cache.get(shoot.brief_id)
    assert.equal(announcement.content, 'React 🎬 to join; remove your reaction to leave.')
    assert.doesNotMatch(JSON.stringify(announcement.embeds), /Owen|Direct invitations/)
    assert.doesNotMatch(announcement.content, /<@|Verified TVM/)
    const invited = brief.embeds[0].toJSON().fields.filter(field => field.name === 'Direct invitations')
    assert.equal(invited.length, 1)
    assert.match(invited[0].value, /Owen/)
    assert.doesNotMatch(invited[0].value, /<@/)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    const updated = brief.embeds[0].toJSON().fields.filter(field => field.name === 'Direct invitations')
    assert.match(updated.map(field => field.value).join(' '), /extra/)
    for (const channel of [f.channels.get(IDS.announce), f.channels.get(shoot.channel_id)]) {
        for (const payload of [...channel.sends, ...[...channel.messages.cache.values()].flatMap(message => message.edits)]) {
            assert.deepEqual(payload.allowedMentions, { parse: [] })
        }
    }
})

test('routine sync and reaction events honor deleted announcements; edit can republish once', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const announcementChannel = f.channels.get(IDS.announce)
    await f.react(shoot, 'joined')
    announcementChannel.messages.cache.delete(shoot.announcement_id)
    await Promise.all([
        f.service.onReaction({ message: { id: shoot.announcement_id, guildId: IDS.guild, channelId: IDS.announce },
            emoji: { name: '🎬' } }, f.members.get(IDS.joined).user),
        f.service.reconcileAll()
    ])
    await f.service.reconcileAll()
    let current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(current.announcement_deleted_at)
    assert.equal(joiningAllowed(current), false)
    assert.equal(announcementChannel.sends.length, 1)
    await f.service.handleInteraction(f.interaction({ command: 'add', channelId: shoot.channel_id }))
    assert.equal(announcementChannel.sends.length, 1)
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    const submit = f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id })
    submit.fields = fields('Edited shoot')
    await f.service.handleInteraction(submit)
    current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.announcement_deleted_at, null)
    assert.notEqual(current.announcement_id, shoot.announcement_id)
    assert.equal(current.join_started_at, shoot.join_started_at)
    assert.equal(announcementChannel.messages.cache.size, 1)
    assert.equal(announcementChannel.sends.length, 2)
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.joined, P.ViewChannel))
    assert.ok(allows(f.channels.get(shoot.channel_id), IDS.extra, P.SendMessages))
    await f.react(current, 'joined')
    await f.react(current, 'joined', false)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), false)
    await f.service.reconcileAll()
    assert.equal(announcementChannel.sends.length, 2)
    assert.equal(f.errors.length, 0)
})

test('closed announcement is removed at the 24-hour boundary without losing archive access', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.react(shoot, 'joined')
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const channel = f.channels.get(IDS.announce)
    const closed = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(closed.closed_at)
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 86400000 + 60000 })
    await f.service.reconcileAll()
    assert.equal(channel.messages.cache.has(shoot.announcement_id), true)
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 86400000 })
    await f.restart()
    await f.service.reconcileAll()
    const removed = await f.store.getShoot(shoot.id, IDS.guild)
    assert.ok(removed.announcement_deleted_at)
    assert.equal(channel.messages.cache.has(shoot.announcement_id), false)
    const chat = f.channels.get(shoot.channel_id)
    assert.ok(allows(chat, IDS.joined, P.ViewChannel))
    assert.equal(allows(chat, IDS.joined, P.SendMessages), false)
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    assert.ok(allows(chat, IDS.joined, P.SendMessages))
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).closed_at, null)
    assert.equal(channel.sends.length, 2)
    assert.equal(channel.messages.cache.size, 1)
    assert.equal(f.errors.length, 0)
})

test('reopening before cleanup cancels deletion and a later close starts a fresh 24-hour period', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const firstClose = Date.now() - 3600000
    await f.store.updateShoot(shoot.id, { closed_at: firstClose })
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).closed_at, firstClose)
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    await f.service.reconcileAll()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).closed_at, null)
    assert.equal(f.channels.get(IDS.announce).messages.cache.has(shoot.announcement_id), true)
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    assert.ok((await f.store.getShoot(shoot.id, IDS.guild)).closed_at > firstClose)
})

test('announcement deletion failures and lost responses retry durably without republishing', async t => {
    for (const failure of ['failDelete', 'failDeleteAfter']) {
        const f = await fixture(t)
        const { shoot } = await f.create()
        await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
        const closedAt = Date.now() - 90000000
        await f.store.updateShoot(shoot.id, { closed_at: closedAt })
        f.channels.get(IDS.announce)[failure] = true
        await f.service.reconcileAll()
        assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).announcement_deleted_at, null)
        assert.equal(f.errors.length, 1)
        await f.restart()
        await f.service.reconcileAll()
        const removed = await f.store.getShoot(shoot.id, IDS.guild)
        assert.ok(removed.announcement_deleted_at)
        assert.equal(removed.closed_at, closedAt)
        assert.equal(f.channels.get(IDS.announce).messages.cache.has(shoot.announcement_id), false)
        assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    }
})

test('closed announcement cleanup still runs if the shoot channel is deleted', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    f.channels.delete(shoot.channel_id)
    await f.service.reconcileAll()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).status, 'missing')
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 90000000 })
    await f.service.reconcileAll()
    assert.ok((await f.store.getShoot(shoot.id, IDS.guild)).announcement_deleted_at)
    assert.equal(f.channels.get(IDS.announce).messages.cache.size, 0)
})

test('older databases add cleanup fields and use the existing closed announcement time', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const oldClosedAt = Date.now() - 90000000
    f.channels.get(IDS.announce).messages.cache.get(shoot.announcement_id).editedTimestamp = oldClosedAt
    await f.store._locked(() => f.store._exec('ALTER TABLE shoots DROP COLUMN closed_at; ALTER TABLE shoots DROP COLUMN announcement_deleted_at; ALTER TABLE shoots DROP COLUMN announcement_republish_pending;'))
    await f.restart()
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).announcement_deleted_at, null)
    await f.service.reconcileAll()
    const current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.closed_at, oldClosedAt)
    assert.ok(current.announcement_deleted_at)
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
})

test('bot startup can republish deleted announcements while routine reconnect sync cannot', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const channel = f.channels.get(IDS.announce)
    channel.messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    await f.service.reconcileAll()
    assert.equal(channel.sends.length, 1)
    await f.restart()
    await f.service.initialize()
    const current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.notEqual(current.announcement_id, shoot.announcement_id)
    assert.equal(current.announcement_deleted_at, null)
    assert.equal(current.join_started_at, shoot.join_started_at)
    assert.equal(channel.sends.length, 2)
    await f.service.reconcileAll()
    assert.equal(channel.sends.length, 2)
    assert.equal(f.errors.length, 0)
})

test('reopening republishes a manually deleted closed announcement without resetting the deadline', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    const channel = f.channels.get(IDS.announce)
    channel.messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    assert.equal(channel.sends.length, 1)
    await f.service.handleInteraction(f.interaction({ command: 'reopen', channelId: shoot.channel_id }))
    const current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.status, 'open')
    assert.equal(current.join_started_at, shoot.join_started_at)
    assert.equal(channel.sends.length, 2)
    assert.ok(channel.messages.cache.get(current.announcement_id).reactions.cache.get('🎬').me)
})

test('closed cleanup stays final through edits and startup until explicitly reopened', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 90000000 })
    await f.service.reconcileAll()
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    await f.service.handleInteraction(f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id }))
    await f.restart()
    await f.service.initialize()
    assert.equal(f.channels.get(IDS.announce).messages.cache.size, 0)
    assert.equal(f.channels.get(IDS.announce).sends.length, 1)
    assert.equal(f.errors.length, 0)
})

test('important-event publication intent survives a lost send response and routine retry', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const channel = f.channels.get(IDS.announce)
    channel.messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    channel.failSendAfter = true
    await f.service.handleInteraction(f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id }))
    const pending = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(pending.announcement_republish_pending, 1)
    assert.equal(pending.announcement_id, shoot.announcement_id)
    assert.equal(channel.messages.cache.size, 1)
    await f.restart()
    await f.service.reconcileAll()
    const current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.announcement_republish_pending, 0)
    assert.equal(current.announcement_deleted_at, null)
    assert.notEqual(current.announcement_id, shoot.announcement_id)
    assert.equal(channel.sends.length, 2)
    assert.deepEqual(channel.sends.at(-1).allowedMentions, { parse: [] })
})

test('a closed announcement with a lost republication response is cleaned up when its original deadline arrives', async t => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const channel = f.channels.get(IDS.announce)
    await f.service.handleInteraction(f.interaction({ command: 'close', channelId: shoot.channel_id }))
    channel.messages.cache.delete(shoot.announcement_id)
    await f.service.reconcileAll()
    const edit = f.interaction({ command: 'edit', channelId: shoot.channel_id })
    await f.service.handleInteraction(edit)
    channel.failSendAfter = true
    await f.service.handleInteraction(f.interaction({ customId: edit.modal.custom_id, channelId: shoot.channel_id }))
    assert.equal(channel.messages.cache.size, 1)
    assert.equal((await f.store.getShoot(shoot.id, IDS.guild)).announcement_republish_pending, 1)
    await f.store.updateShoot(shoot.id, { closed_at: Date.now() - 90000000 })
    await f.restart()
    await f.service.initialize()
    const current = await f.store.getShoot(shoot.id, IDS.guild)
    assert.equal(current.announcement_republish_pending, 0)
    assert.ok(current.announcement_deleted_at)
    assert.equal(channel.messages.cache.size, 0)
    assert.equal(channel.sends.length, 2)
})
