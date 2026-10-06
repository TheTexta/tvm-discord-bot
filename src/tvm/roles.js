// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const roleKinds = ['member', 'exec', 'admin']
const rosterRoles = ['gm', 'exec', 'admin']
const managedColumns = { member: 'managed_role', exec: 'managed_exec_role', admin: 'managed_admin_role' }
const desiredKinds = (role) =>
    role === 'exec' ? ['member', 'exec'] : role === 'admin' ? ['member', 'admin'] : ['member']
const configuredRoleIds = (config) => ({
    member: config.memberRoleId,
    exec: config.execRoleId,
    admin: config.adminRoleId
})

function parseRole(value) {
    const label = String(value ?? '')
        .trim()
        .toLowerCase()
    return label === 'gm'
        ? 'gm'
        : /^exec\s*[-:]\s*(editor|producer)$/.test(label)
          ? 'exec'
          : label === 'admin'
            ? 'admin'
            : null
}

module.exports = { roleKinds, rosterRoles, managedColumns, desiredKinds, configuredRoleIds, parseRole }
