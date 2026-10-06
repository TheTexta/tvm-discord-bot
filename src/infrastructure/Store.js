// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const SqliteDatabase = require('./SqliteDatabase')
const MembershipRepository = require('../membership/MembershipRepository')
const ShootRepository = require('../shoots/ShootRepository')

// Lifecycle owner and compatibility facade; repositories share one connection and queue.
class Store extends SqliteDatabase {
    constructor(filename, codeSecret) {
        super(filename)
        this.membership = new MembershipRepository(this, codeSecret)
        this.shoots = new ShootRepository(this)
    }
    status(...args) {
        return this.membership.status(...args)
    }
    rosterEntries(...args) {
        return this.membership.rosterEntries(...args)
    }
    lookup(...args) {
        return this.membership.lookup(...args)
    }
    replaceRoster(...args) {
        return this.membership.replaceRoster(...args)
    }
    allowRequest(...args) {
        return this.membership.allowRequest(...args)
    }
    reserveSend(...args) {
        return this.membership.reserveSend(...args)
    }
    savePending(...args) {
        return this.membership.savePending(...args)
    }
    pendingFor(...args) {
        return this.membership.pendingFor(...args)
    }
    verifyAndClaim(...args) {
        return this.membership.verifyAndClaim(...args)
    }
    removedClaims(...args) {
        return this.membership.removedClaims(...args)
    }
    activeClaims(...args) {
        return this.membership.activeClaims(...args)
    }
    activeClaimUserIds(...args) {
        return this.membership.activeClaimUserIds(...args)
    }
    isAuthorizedUser(...args) {
        return this.membership.isAuthorizedUser(...args)
    }
    claimForUser(...args) {
        return this.membership.claimForUser(...args)
    }
    claimFor(...args) {
        return this.membership.claimFor(...args)
    }
    markRoleManaged(...args) {
        return this.membership.markRoleManaged(...args)
    }
    clearRoleManaged(...args) {
        return this.membership.clearRoleManaged(...args)
    }
    releaseClaim(...args) {
        return this.membership.releaseClaim(...args)
    }
    transfer(...args) {
        return this.membership.transfer(...args)
    }
    audit(...args) {
        return this.membership.audit(...args)
    }
    async sweep() {
        await this.membership.sweep()
        await this.shoots.sweepDrafts()
    }
    createShootDraft(...args) {
        return this.shoots.createShootDraft(...args)
    }
    getShoot(...args) {
        return this.shoots.getShoot(...args)
    }
    shootForChannel(...args) {
        return this.shoots.shootForChannel(...args)
    }
    shootForAnnouncement(...args) {
        return this.shoots.shootForAnnouncement(...args)
    }
    allShoots(...args) {
        return this.shoots.allShoots(...args)
    }
    updateShoot(...args) {
        return this.shoots.updateShoot(...args)
    }
    shootParticipants(...args) {
        return this.shoots.shootParticipants(...args)
    }
    setShootReaction(...args) {
        return this.shoots.setShootReaction(...args)
    }
    inviteShootParticipant(...args) {
        return this.shoots.inviteShootParticipant(...args)
    }
}
module.exports = Store
