// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const fs = require('node:fs')
const { healthPath, checkHealth } = require('../src/infrastructure/HealthReporter')
try {
    checkHealth(JSON.parse(fs.readFileSync(healthPath(process.env.TVM_DATABASE_PATH || './config/tvm.db'), 'utf8')))
    console.log('Bot health check passed')
} catch (error) {
    console.error(error.message)
    process.exitCode = 1
}
