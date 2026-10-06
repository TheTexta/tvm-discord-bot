// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

class Repository {
    constructor(database) {
        this.database = database
    }
    _locked(work) {
        return this.database._locked(work)
    }
    _transaction(work) {
        return this.database._transaction(work)
    }
    _run(sql, params) {
        return this.database._run(sql, params)
    }
    _get(sql, params) {
        return this.database._get(sql, params)
    }
    _all(sql, params) {
        return this.database._all(sql, params)
    }
}
module.exports = Repository
