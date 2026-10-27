// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AdminOperationError, withAdminOperation } = require('../src/shared/AdminOperation')

test('pre-save failures retain their identity, while pending and completed outcomes never report failure to save', async () => {
    const error = new Error('private transport error')
    await assert.rejects(
        withAdminOperation(async () => {
            throw error
        }),
        (value) => value === error
    )
    await assert.rejects(
        withAdminOperation(async (operation) => {
            operation.saved('Retry the existing link.')
            throw error
        }),
        (value) => {
            assert.ok(value instanceof AdminOperationError)
            assert.equal(value.cause, error)
            assert.match(value.message, /saved.*synchronization is pending/)
            assert.doesNotMatch(value.message, /private transport/)
            return true
        }
    )
    await assert.rejects(
        withAdminOperation(async (operation) => {
            operation.completed()
            await operation.confirm('Membership transferred.', async () => {
                throw error
            })
        }),
        /action was accepted.*confirmation could not be delivered.*Membership transferred/
    )
})

test('concurrent operation outcomes cannot contaminate one another', async () => {
    const results = await Promise.allSettled([
        withAdminOperation(async (operation) => {
            operation.saved()
            await Promise.resolve()
            throw new Error('saved')
        }),
        withAdminOperation(async () => {
            await Promise.resolve()
            throw new Error('not saved')
        })
    ])
    assert.ok(results[0].reason instanceof AdminOperationError)
    assert.equal(results[1].reason instanceof AdminOperationError, false)
    assert.equal(results[1].reason.message, 'not saved')
})
