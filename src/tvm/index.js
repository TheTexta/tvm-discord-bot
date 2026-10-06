// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'
const { main } = require('../app/index')
if (require.main === module)
    main().catch((error) => {
        console.error('[TVM] Startup failed:', error.message)
        process.exitCode = 1
    })
module.exports = { main }
