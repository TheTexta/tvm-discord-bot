// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

// Persisted recovery identifiers must remain compatible with existing Discord resources.
const shootMarker = (shootId, kind) => `TVM shoot ${shootId} · ${kind}`
const shootTopic = (shootId) => `TVM shoot ${shootId}`

module.exports = { shootMarker, shootTopic }
