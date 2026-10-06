// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

async function addColumns(store, definitions) {
    for (const [table, column, declaration] of definitions) {
        const columns = await store._all(`PRAGMA table_info(${table})`)
        if (!columns.some((item) => item.name === column)) {
            await store._exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
        }
    }
}

const migrations = [
    {
        version: 1,
        name: 'initial-email-and-shoot-schema',
        apply: (store) =>
            store._exec(`
            CREATE TABLE IF NOT EXISTS email_roster (guild_id TEXT NOT NULL, email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'gm',
                PRIMARY KEY (guild_id, email));
            CREATE TABLE IF NOT EXISTS email_roster_meta (guild_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS email_claims (guild_id TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL, managed_role INTEGER NOT NULL DEFAULT 0,
                managed_exec_role INTEGER NOT NULL DEFAULT 0, managed_admin_role INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (guild_id, email), UNIQUE (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS email_pending (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL,
                roster_version INTEGER NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
            CREATE TABLE IF NOT EXISTS email_request_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                email_key TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_request_events_at ON email_request_events(at);
            CREATE TABLE IF NOT EXISTS email_send_events (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                email_key TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_send_events_at ON email_send_events(at);
            CREATE TABLE IF NOT EXISTS email_admin_audit (guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_email_admin_audit_guild_at ON email_admin_audit(guild_id, at);
            CREATE TABLE IF NOT EXISTS shoots (
                id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, organizer_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '', call_time INTEGER, location TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft', channel_id TEXT UNIQUE, brief_id TEXT,
                announcement_id TEXT UNIQUE, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
                join_period TEXT NOT NULL DEFAULT 'never', join_started_at INTEGER,
                announcement_deleted_at INTEGER, closed_at INTEGER, announcement_republish_pending INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS idx_shoots_guild ON shoots(guild_id);
            CREATE TABLE IF NOT EXISTS shoot_participants (
                shoot_id TEXT NOT NULL, user_id TEXT NOT NULL, invited INTEGER NOT NULL DEFAULT 0,
                reacted INTEGER NOT NULL DEFAULT 0, reaction_message_id TEXT, PRIMARY KEY (shoot_id, user_id));
    `)
    },
    {
        version: 2,
        name: 'roster-tiers-and-role-ownership',
        apply: (store) =>
            addColumns(store, [
                ['email_roster', 'role', "TEXT NOT NULL DEFAULT 'gm'"],
                ['email_claims', 'managed_role', 'INTEGER NOT NULL DEFAULT 0'],
                ['email_claims', 'managed_exec_role', 'INTEGER NOT NULL DEFAULT 0'],
                ['email_claims', 'managed_admin_role', 'INTEGER NOT NULL DEFAULT 0']
            ])
    },
    {
        version: 3,
        name: 'reaction-message-tracking',
        apply: (store) => addColumns(store, [['shoot_participants', 'reaction_message_id', 'TEXT']])
    },
    {
        version: 4,
        name: 'shoot-joining-windows',
        apply: (store) =>
            addColumns(store, [
                ['shoots', 'join_period', "TEXT NOT NULL DEFAULT 'never'"],
                ['shoots', 'join_started_at', 'INTEGER'],
                ['shoots', 'announcement_deleted_at', 'INTEGER']
            ])
    },
    {
        version: 5,
        name: 'closed-announcement-cleanup',
        apply: (store) => addColumns(store, [['shoots', 'closed_at', 'INTEGER']])
    },
    {
        version: 6,
        name: 'durable-announcement-republication',
        apply: (store) =>
            addColumns(store, [['shoots', 'announcement_republish_pending', 'INTEGER NOT NULL DEFAULT 0']])
    }
]

async function migrate(store) {
    await store._exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS tvm_schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);`)
    const newest = await store._get('SELECT MAX(version) AS version FROM tvm_schema_migrations')
    if (newest.version > migrations.at(-1).version) throw new Error('Database schema is newer than this runtime')
    for (const migration of migrations) {
        await store._transaction(async () => {
            if (await store._get('SELECT 1 FROM tvm_schema_migrations WHERE version = ?', [migration.version])) return
            await migration.apply(store)
            await store._run('INSERT INTO tvm_schema_migrations VALUES (?, ?, ?)', [
                migration.version,
                migration.name,
                Date.now()
            ])
        })
    }
}

module.exports = { migrate, migrations }
