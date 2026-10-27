// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { uiText } = require('./uiText')

class AdminOperationError extends Error {}

// Keep the outcome alongside the operation, not in Discord's reply state: a
// successful write and a failed confirmation are independent outcomes.
async function withAdminOperation(work) {
    let saved = false
    let completed = false
    let confirmation
    let nextSteps = uiText('admin.reconcileNextSteps')
    try {
        return await work({
            saved(message = nextSteps) {
                saved = true
                nextSteps = message
            },
            completed() {
                saved = completed = true
            },
            async confirm(content, send) {
                confirmation = content
                return send(content)
            }
        })
    } catch (error) {
        if (!saved) throw error
        const message = confirmation
            ? uiText('admin.confirmationFailed', { result: confirmation })
            : completed
              ? uiText('admin.completedWithoutConfirmation')
              : uiText('admin.syncPending', { nextSteps })
        throw new AdminOperationError(message, { cause: error })
    }
}

module.exports = { withAdminOperation, AdminOperationError }
