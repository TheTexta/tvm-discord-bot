// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const SelfSmtpProvider = require('../src/mail/providers/SelfSmtpProvider')

test('SMTP delivery times out when a server accepts connections but never greets', { timeout: 2000 }, async (t) => {
    const connections = new Set()
    const server = net.createServer((socket) => {
        connections.add(socket)
        socket.on('close', () => connections.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const mail = new SelfSmtpProvider({
        smtpHost: '127.0.0.1',
        smtpPort: server.address().port,
        username: 'test',
        password: 'test',
        isSecure: false,
        fromAddress: 'verify@example.org'
    })
    t.after(async () => {
        mail.close()
        for (const socket of connections) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
    })
    const options = mail.transporter.transporter.options
    for (const name of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) {
        assert.ok(options[name] > 0 && options[name] <= 20000, `${name} must be bounded`)
    }
    // Shorten just this test's greeting deadline while exercising real SMTP I/O.
    options.greetingTimeout = 30
    await assert.rejects(mail.sendMail({ fromName: 'TVM', to: 'member@example.org', subject: 'Test', text: 'Test' }), {
        code: 'ETIMEDOUT',
        command: 'CONN'
    })
})
