// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

// Expected command/form rejections are private feedback, not infrastructure incidents.
class ShootInputError extends Error {
    constructor(message, code) {
        super(message)
        this.code = code
    }
}

module.exports = ShootInputError
