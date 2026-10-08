// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Collection, Embed, ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js')
const Store = require('../../src/infrastructure/Store')
const { ShootService } = require('../../src/shoots/ShootService')

const IDS = {
    guild: '100000000000000001',
    bot: '100000000000000002',
    admin: '100000000000000003',
    invited: '100000000000000004',
    joined: '100000000000000005',
    outsider: '100000000000000006',
    announce: '100000000000000007',
    active: '100000000000000008',
    archive: '100000000000000009',
    other: '100000000000000010',
    extra: '100000000000000011',
    adminRole: '100000000000000012',
    memberRole: '100000000000000013',
    execRole: '100000000000000014'
}
const fields = (name = 'TVM film', value = '2026-10-15 13:30', location = 'Studio', period = 'day') => {
    const [date = '', time = ''] = value.split(' ')
    return { getTextInputValue: (key) => ({ name, date, time, location })[key], getStringSelectValues: () => [period] }
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-shoot-'))
    const filename = path.join(dir, 'tvm.db')
    let store = new Store(filename, 's'.repeat(32))
    await store.ready
    t.after(async () => {
        service.stop()
        await service.drain()
        await store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    await store.replaceRoster(
        IDS.guild,
        ['invited', 'joined', 'extra'].map((name) => ({ email: `${name}@example.org`, role: 'gm' })),
        IDS.admin
    )
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
    const restEmbeds = (embeds) =>
        (embeds || []).map((embed) => {
            const data = embed.toJSON()
            return new Embed({
                ...data,
                type: 'rich',
                fields: data.fields?.map((field) => ({ ...field, inline: Boolean(field.inline) }))
            })
        })
    for (const [name, id] of Object.entries(IDS)) {
        if (!['bot', 'admin', 'invited', 'joined', 'outsider', 'extra'].includes(name)) continue
        const user = {
            id,
            username: name,
            bot: name === 'bot',
            send: async (payload) => {
                notices.push({ id, payload })
            }
        }
        const member = {
            id,
            user,
            roles: {
                cache: new Collection(
                    ['invited', 'joined', 'extra'].includes(name) ? [[IDS.memberRole, { id: IDS.memberRole }]] : []
                )
            },
            permissions: new PermissionsBitField(name === 'admin' || name === 'bot' ? P.Administrator : 0n)
        }
        members.set(id, member)
    }
    function channel(id, type = ChannelType.GuildText, options = {}) {
        const messages = new Collection()
        const object = {
            id,
            guildId: IDS.guild,
            type,
            parentId: options.parent || null,
            topic: options.topic,
            permissionOverwrites: { cache: new Collection() },
            permissions: new PermissionsBitField(P.Administrator),
            permissionsFor: () => object.permissions,
            edits: [],
            sends: [],
            edit: async (options) => {
                if (object.failEdit) {
                    object.failEdit = false
                    throw new Error('permission failure')
                }
                object.edits.push(options)
                if (options.parent) object.parentId = options.parent
                if (options.permissionOverwrites) {
                    object.permissionOverwrites.cache = new Collection(
                        options.permissionOverwrites.map((entry) => [
                            entry.id,
                            {
                                ...entry,
                                allow: new PermissionsBitField(entry.allow),
                                deny: new PermissionsBitField(entry.deny)
                            }
                        ])
                    )
                }
                return object
            },
            messages: {
                cache: messages,
                delete: async (id) => {
                    if (object.failDelete) {
                        object.failDelete = false
                        throw new Error('announcement deletion failed')
                    }
                    if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 })
                    messages.delete(id)
                    if (object.failDeleteAfter) {
                        object.failDeleteAfter = false
                        throw new Error('delete response lost')
                    }
                },
                fetch: async (input) => {
                    if (typeof input === 'string' || input.message) {
                        const id = typeof input === 'string' ? input : input.message
                        assert.equal(input.force, true, 'stored messages must bypass cached reaction state')
                        if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 })
                        return messages.get(id)
                    }
                    return new Collection(
                        [...messages]
                            .sort((a, b) => b[0].localeCompare(a[0]))
                            .filter(([id]) => !input.before || id < input.before)
                            .slice(0, input.limit)
                    )
                }
            },
            send: async (payload) => {
                const existing = [...messages.values()].find((message) => message.nonce === payload.nonce)
                if (payload.enforceNonce && existing) return existing
                object.sends.push(payload)
                const message = {
                    id: nextId(),
                    channelId: id,
                    guildId: IDS.guild,
                    author: members.get(IDS.bot).user,
                    embeds: restEmbeds(payload.embeds),
                    content: payload.content || '',
                    nonce: payload.nonce,
                    pinned: false,
                    createdTimestamp: Date.now(),
                    reactions: { cache: new Collection() },
                    edits: [],
                    edit: async (payload) => {
                        message.edits.push(payload)
                        message.embeds = restEmbeds(payload.embeds)
                        message.content = payload.content
                        return message
                    },
                    pin: async () => {
                        message.pinned = true
                    },
                    react: async (emoji) => {
                        const reaction = addReaction(message, emoji)
                        reaction.me = true
                        reaction.normal.set(IDS.bot, members.get(IDS.bot).user)
                        return reaction
                    }
                }
                messages.set(message.id, message)
                if (object.failSendAfter) {
                    object.failSendAfter = false
                    throw new Error('send response lost')
                }
                return message
            }
        }
        channels.set(id, object)
        if (options.permissionOverwrites) awaitableOverwrites(object, options.permissionOverwrites)
        return object
    }
    function awaitableOverwrites(object, entries) {
        object.permissionOverwrites.cache = new Collection(
            entries.map((entry) => [
                entry.id,
                { ...entry, allow: new PermissionsBitField(entry.allow), deny: new PermissionsBitField(entry.deny) }
            ])
        )
    }
    function addReaction(message, emoji = '🎬') {
        if (message.reactions.cache.has(emoji)) return message.reactions.cache.get(emoji)
        const reaction = {
            message,
            emoji: { id: null, name: emoji },
            me: false,
            normal: new Collection(),
            burst: new Collection(),
            pages: [],
            users: {
                fetch: async (options) => {
                    reaction.pages.push(options)
                    const users = options.type ? reaction.burst : reaction.normal
                    return new Collection(
                        [...users]
                            .sort((a, b) => a[0].localeCompare(b[0]))
                            .filter(([id]) => !options.after || id > options.after)
                            .slice(0, options.limit)
                    )
                },
                remove: async (id) => {
                    reaction.normal.delete(id)
                    reaction.burst.delete(id)
                }
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
        members: {
            fetchMe: async () => members.get(IDS.bot),
            fetch: async (input) => {
                const id = typeof input === 'string' ? input : input.user
                if (!members.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 })
                return members.get(id)
            }
        },
        channels: {
            fetch: async (id) => {
                if (!id) return channels
                if (!channels.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 })
                return channels.get(id)
            },
            create: async (options) => {
                const result = channel(nextId(), options.type, options)
                if (guild.failCreateAfter) {
                    guild.failCreateAfter = false
                    throw new Error('channel response lost')
                }
                return result
            }
        }
    }
    const client = { user: members.get(IDS.bot).user, guilds: { fetch: async () => guild } }
    const config = {
        guildId: IDS.guild,
        memberRoleId: IDS.memberRole,
        execRoleId: IDS.execRole,
        adminRoleId: IDS.adminRole,
        shoots: { announcementChannelId: IDS.announce, categoryId: IDS.active, archiveCategoryId: IDS.archive }
    }
    const service = new ShootService({ client, store, config, alertAdmins: async (message) => errors.push(message) })
    service.report = async (id, error) => {
        errors.push({ id, error: error.message })
    }
    function interaction({
        command = null,
        customId = null,
        channelId = IDS.other,
        userId = IDS.admin,
        mentions = '',
        addUserId = IDS.extra
    } = {}) {
        return {
            guild,
            guildId: IDS.guild,
            channelId,
            channel: channels.get(channelId),
            user: members.get(userId).user,
            memberPermissions: members.get(userId).permissions,
            member: members.get(userId),
            commandName: command ? 'shoot' : null,
            customId,
            options: {
                getSubcommand: () => command,
                getString: () => mentions,
                getUser: () => members.get(addUserId).user
            },
            fields: fields(),
            isChatInputCommand: () => Boolean(command),
            isButton: () => Boolean(customId?.startsWith('tvm:shoot:form:')),
            isModalSubmit: () => Boolean(customId && !customId.startsWith('tvm:shoot:form:')),
            replies: [],
            reply: async function (payload) {
                this.replied = true
                this.replies.push(payload)
            },
            editReply: async function (payload) {
                this.replies.push(payload)
                const button = payload.components?.[0]?.toJSON().components[0]
                if (button?.custom_id?.startsWith('tvm:shoot:form:')) {
                    const click = interaction({ customId: button.custom_id, channelId, userId })
                    await service.handleInteraction(click)
                    this.modal = click.modal
                }
            },
            deferReply: async function () {
                this.deferred = true
            },
            showModal: async function (modal) {
                this.modal = modal.toJSON()
                this.replied = true
            }
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
            await service.onReaction(
                {
                    emoji: reaction.emoji,
                    partial: true,
                    message: { id: message.id, guildId: IDS.guild, channelId: IDS.announce, partial: true }
                },
                user
            )
        }
        return reaction
    }
    return {
        get store() {
            return store
        },
        service,
        guild,
        config,
        client,
        channels,
        members,
        notices,
        errors,
        interaction,
        create,
        react,
        channel,
        addReaction,
        restart: async () => {
            await store.close()
            store = new Store(filename, 's'.repeat(32))
            await store.ready
            service.store = store
        }
    }
}

function allows(channel, userId, flag) {
    const overwrite = channel.permissionOverwrites.cache.get(userId)
    return Boolean(overwrite?.allow.has(flag))
}

// These tests exercise real SQLite persistence and a Discord adapter that can lose successful responses.

module.exports = { IDS, fields, fixture, allows }
