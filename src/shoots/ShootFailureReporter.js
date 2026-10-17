// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')
const { escapeMarkdown } = require('discord.js')
const { uiText } = require('../shared/uiText')

const TRANSIENT_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'
])
const GRACE_MS = 2 * 60000
const identifier = (value) => (typeof value === 'string' && /^[\w:-]{1,100}$/.test(value) ? value : null)
const label = (value) =>
    escapeMarkdown(
        String(value || 'Unnamed shoot')
            .replace(/https?:\/\/\S+/gi, '[URL]')
            .replace(/[@<>`\r\n]/g, ' ')
            .slice(0, 100)
    )

function diagnostics(error) {
    const status = Number.isInteger(error?.status) ? error.status : null
    let code = error?.code
    let networkCode
    let cause = error
    for (let depth = 0; depth < 4 && cause; depth++, cause = cause.cause) {
        if (TRANSIENT_CODES.has(cause.code)) {
            networkCode = cause.code
            break
        }
    }
    code ??= networkCode
    code = Number.isInteger(code)
        ? code
        : typeof code === 'string' &&
            /^(SQLITE_[A-Z_]+|ERR_[A-Z_]+|UND_ERR_[A-Z_]+|E[A-Z_]+|TVM_SHOOT_CHANNEL_MISSING|TVM_SHOOT_FULL)$/.test(
                code
            ) &&
            code.length < 80
          ? code
          : null
    const name =
        /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|HTTPError|DiscordAPIError(?:\[\d+\])?|AbortError|TimeoutError)$/.test(
            error?.name
        )
            ? error.name
            : 'Error'
    const transient =
        status != null
            ? (status >= 500 && status < 600) || status === 408 || status === 429
            : TRANSIENT_CODES.has(code) ||
              TRANSIENT_CODES.has(networkCode) ||
              ['AbortError', 'TimeoutError'].includes(name)
    let route = null
    try {
        const url = new URL(error.url)
        if (['discord.com', 'discordapp.com'].includes(url.hostname)) {
            const segments = url.pathname.replace(/^\/api\/v\d+\//, '').split('/')
            if (['channels', 'guilds', 'users'].includes(segments[0])) {
                const fixed = new Set([
                    'channels',
                    'guilds',
                    'users',
                    'messages',
                    'reactions',
                    'roles',
                    'members',
                    'pins',
                    '@me'
                ])
                route =
                    '/' +
                    segments.map((part) => (fixed.has(part) ? part : /^\d+$/.test(part) ? ':id' : ':value')).join('/')
            }
        }
    } catch {
        // Never log an unparsed URL: it may contain credentials or interaction tokens.
    }
    // Only retain source locations, never the stack's first line or arbitrary error text.
    const stack = String(error?.stack || '')
        .slice(0, 12000)
        .split('\n')
        .slice(1)
        .flatMap((line) => {
            const match = line.match(/(?:^|\s|\()((?:\/|file:\/\/\/|node:)[^()\s]+):(\d+):(\d+)\)?$/)
            if (!match) return []
            const source = match[1].match(/\/(src|node_modules|test)\/([\w./@+-]+)$/)
            const file = source
                ? `${source[1]}/${source[2]}`
                : /^node:[\w/_.-]+$/.test(match[1])
                  ? match[1]
                  : '<external>'
            return [`${file}:${match[2]}:${match[3]}`]
        })
        .slice(0, 12)
    const summary =
        code === 'TVM_SHOOT_CHANNEL_MISSING'
            ? 'Shoot channel is missing; it will not be recreated automatically'
            : code === 'TVM_SHOOT_FULL'
              ? 'Shoot participant limit exceeded'
              : status === 403 || code === 50013 || code === 50001
                ? 'Discord access or permissions denied'
                : status
                  ? `Discord request failed (HTTP ${status}${code ? `, code ${code}` : ''})`
                  : TRANSIENT_CODES.has(code) || ['AbortError', 'TimeoutError'].includes(name)
                    ? `Discord connection interrupted (${code || name})`
                    : code?.startsWith?.('SQLITE_')
                      ? `Database operation failed (${code})`
                      : `Unexpected ${name}; see bot logs`
    return {
        name,
        status,
        code,
        method: /^(GET|POST|PUT|PATCH|DELETE)$/.test(error?.method) ? error.method : null,
        route,
        transient,
        summary,
        stack
    }
}

class ShootFailureReporter {
    constructor({ alertAdmins, logger = console, now = Date.now }) {
        this.alertAdmins = alertAdmins
        this.logger = logger
        this.now = now
        this.context = new AsyncLocalStorage()
        this.errors = new WeakMap()
        this.incidents = new Map()
    }

    update(values) {
        Object.assign(this.context.getStore() || {}, values)
    }

    capture(error, operation) {
        if (!error || (typeof error !== 'object' && typeof error !== 'function')) error = new Error('Non-Error failure')
        const scope = this.context.getStore()
        let previous = this.errors.get(error)
        let ancestor = previous?._scope
        while (ancestor && ancestor !== scope) ancestor = ancestor._parent
        if (scope && ancestor !== scope) previous = undefined
        this.errors.set(error, {
            ...scope,
            ...previous,
            _scope: previous?._scope || scope,
            ...(operation && !previous?.operation ? { operation } : {})
        })
        return error
    }

    async operation(operation, work) {
        try {
            return await work()
        } catch (error) {
            throw this.capture(error, operation)
        }
    }

    run(context, work) {
        return this.context.run({ ...context, _parent: this.context.getStore() }, async () => {
            try {
                return await work()
            } catch (error) {
                throw this.capture(error)
            }
        })
    }

    key(context) {
        return `${context.shootId || context.channelId || 'runtime'}:${context.workflow || 'sync'}`
    }

    async notify(message) {
        try {
            return (await this.alertAdmins(message)) === true
        } catch {
            this.logger.error('[TVM Shoot]', JSON.stringify({ event: 'alert_delivery_failed' }))
            return false
        }
    }

    async failure(id, error, extra = {}) {
        const details = this.errors.get(error) || {}
        const context = { shootId: id, workflow: 'sync', ...details, ...extra }
        if (context.persisted && !context.synchronized) context.workflow = 'sync'
        const safe = {
            shootId: identifier(context.shootId),
            channelId: identifier(context.channelId),
            name: label(context.name),
            status: identifier(context.status),
            trigger: identifier(context.trigger) || 'unknown',
            workflow: identifier(context.workflow) || 'sync',
            operation: identifier(context.operation) || 'unknown'
        }
        const key = this.key(safe)
        const detail = diagnostics(error)
        let incident = this.incidents.get(key)
        if (!incident) {
            incident = { reference: randomUUID().slice(0, 8), firstAt: this.now(), attempts: 0, alerted: false }
            this.incidents.set(key, incident)
        }
        incident.context = safe
        incident.resolvedAt = null
        incident.attempts++
        this.logger.error(
            '[TVM Shoot]',
            JSON.stringify({
                event: 'failure',
                reference: incident.reference,
                ...safe,
                attempts: incident.attempts,
                ...detail
            })
        )
        const waiting = detail.transient && context.retrying && this.now() - incident.firstAt < GRACE_MS
        if (!waiting && !incident.alerted) {
            incident.alerted = await this.notify(
                uiText('shoot.alert', {
                    shoot: this.description(safe),
                    operation: safe.operation,
                    error: detail.summary,
                    reference: incident.reference
                })
            )
        }
        return incident.reference
    }

    description(context) {
        return `${context.name} (${context.status || 'unknown'}; ${context.shootId || 'runtime'})${context.channelId ? ` <#${context.channelId}>` : ''}`
    }

    async recovered(context) {
        const key = this.key(context)
        const incident = this.incidents.get(key)
        if (!incident) return
        if (incident.resolvedAt == null) {
            incident.resolvedAt = this.now()
            this.logger.log(
                '[TVM Shoot]',
                JSON.stringify({
                    event: 'recovered',
                    reference: incident.reference,
                    ...incident.context,
                    durationMs: incident.resolvedAt - incident.firstAt
                })
            )
        }
        if (
            !incident.alerted ||
            (await this.notify(
                uiText('shoot.recovered', {
                    shoot: this.description(incident.context),
                    reference: incident.reference
                })
            ))
        )
            this.incidents.delete(key)
    }
}

module.exports = { ShootFailureReporter, diagnostics }
