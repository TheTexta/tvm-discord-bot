// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, IDS } = require('./helpers/shoot')

test('shoot form preparation defers before database waits and its button needs no database reads', async (t) => {
    const f = await fixture(t)
    let release, entered
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const waiting = new Promise((resolve) => {
        entered = resolve
    })
    const create = f.store.createShootDraft.bind(f.store)
    f.store.createShootDraft = async (...args) => {
        entered()
        await gate
        return create(...args)
    }
    const setup = f.interaction({ command: 'setup' })
    const request = f.service.handleInteraction(setup)
    await waiting
    assert.equal(setup.deferred, true)
    release()
    await request
    assert.ok(setup.modal)
    const id = setup.replies[0].components[0].toJSON().components[0].custom_id
    f.store.getShoot = async () => {
        throw new Error('Database must not be used by form button')
    }
    const click = f.interaction({ customId: id })
    await f.service.handleInteraction(click)
    assert.ok(click.modal)
    const stale = f.interaction({ customId: id })
    f.service.forms.clear()
    await f.service.handleInteraction(stale)
    assert.equal(stale.modal, undefined)
    assert.match(stale.replies[0].content, /expired|again|reopen/i)
})

test('inactive historical invitations do not fill a shoot or block an eligible applicant', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    for (let i = 0; i < 96; i++)
        await f.store.inviteShootParticipant(shoot.id, `20000000000000${String(i).padStart(4, '0')}`)
    assert.equal((await f.store.shootParticipants(shoot.id)).length, 98)
    assert.equal((await f.service.participantIds(shoot, f.guild)).length, 2)
    await f.react(shoot, 'joined')
    assert.equal((await f.store.shootParticipants(shoot.id)).find((row) => row.user_id === IDS.joined).reacted, 1)
    assert.equal(f.channels.get(shoot.channel_id).permissionOverwrites.cache.has(IDS.joined), true)
})

test('reaction bursts coalesce and changes during a running pass get one trailing pass', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    let passes = 0,
        release,
        entered
    const gate = new Promise((resolve) => {
        release = resolve
    })
    const waiting = new Promise((resolve) => {
        entered = resolve
    })
    const reconcile = f.service.reconcileReactions.bind(f.service)
    f.service.reconcileReactions = async (current) => {
        passes++
        if (passes === 1) {
            entered()
            await gate
        }
        return reconcile(current)
    }
    const jobs = Array.from({ length: 20 }, () => f.service.scheduleReaction(shoot.id))
    assert.ok(jobs.every((job) => job === jobs[0]))
    await waiting
    f.service.scheduleReaction(shoot.id)
    f.service.scheduleReaction(shoot.id)
    release()
    await Promise.all(jobs)
    assert.equal(passes, 2)
    await f.service.drain()
})

test('shutdown flushes accepted reaction work and removes pending timers', async (t) => {
    const f = await fixture(t)
    const { shoot } = await f.create()
    const job = f.service.scheduleReaction(shoot.id)
    f.service.stop()
    await f.service.drain()
    await job
    assert.equal(f.service.reactionJobs.size, 0)
})
