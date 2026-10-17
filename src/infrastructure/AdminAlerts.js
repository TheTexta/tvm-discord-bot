// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

function createAdminAlerter({ send, isReady, logger = console, now = Date.now }) {
    const delivered = new Map()
    const pending = new Map()
    return async function alertAdmins(message) {
        if (!isReady()) {
            logger.error('[TVM] Administrator alert unavailable')
            return false
        }
        for (const [key, at] of delivered) if (now() - at >= 5 * 60000) delivered.delete(key)
        if (delivered.has(message)) return true
        if (pending.has(message)) return pending.get(message)
        const job = Promise.resolve().then(async () => {
            try {
                if ((await send(message)) !== true) return false
                delivered.set(message, now())
                return true
            } catch {
                // Do not print the transport error: request URLs/bodies can contain secrets.
                logger.error('[TVM] Could not send administrator alert')
                return false
            }
        })
        pending.set(message, job)
        try {
            return await job
        } finally {
            pending.delete(message)
        }
    }
}

module.exports = { createAdminAlerter }
