# Operations

## Deployment

Use the Dockerfile or existing Compose service in Coolify. Set the environment variables from `.env.example`, run **one replica**, and persist `/usr/app/config`. No public port is needed. The container runs as UID/GID 1000; preserve that ownership and restrictive database permissions.

For local Compose:

```sh
docker compose --env-file .env.local up --build -d
```

In Coolify, enable **consistent container names** and set the stop grace period to **30 seconds** so deployments stop the previous bot before starting its replacement. Keep one application and one replica.

Before an upgrade, take a SQLite backup and confirm the test and container checks pass. Stop the old bot before starting its replacement: process-local locks cannot coordinate overlapping replicas. Shutdown drains accepted work with a 25-second deadline; allow at least 30 seconds before killing the container.

After deployment, run `npm run discord:check`, inspect the startup log and private alert channel, and confirm `/source` points to the deployed public repository. In a controlled test server, verify roster-based access, release/transfer, reaction joining, private shoot visibility, and read-only archival. Avoid manipulating production members to perform smoke tests.

## Backup and restore

Use SQLite’s backup API or `.backup`; copying only a live main database can omit committed data from its WAL file. For the Compose service:

```sh
docker compose exec -T tvm-verification sh -c 'umask 077; sqlite3 /usr/app/config/tvm.db ".backup /usr/app/config/tvm-backup.db"'
docker compose exec -T tvm-verification sqlite3 /usr/app/config/tvm-backup.db 'PRAGMA integrity_check;'
```

Copy the snapshot off the host into private storage, encrypt it using your managed backup key, and remove temporary snapshots. Keep backups outside Git. Record the deployed commit, schema version, and backup time.

Restore first into an isolated temporary database. Check integrity, schema migration records, and roster/claim counts. A test runtime must use Discord/mail adapters or a dedicated test server, never the production bot token. Rehearse recovery periodically.

For production restoration, stop the bot, preserve the current database for investigation, replace the database from the validated snapshot, and remove obsolete WAL/SHM sidecars while no process has it open. Restore UID/GID 1000 ownership and mode `0600`, then start one replica and reconcile. Match the runtime to the restored schema; a database newer than the runtime is rejected.

## Maintenance scripts

`roster:check` is read-only and can run while the bot is active. **Stop the bot before running database-writing scripts**, including `import-initial-roster.js` and `update-roster-roles.js`. Their database connections do not participate in the runtime’s membership lock. Back up first, supply the expected row count, then restart and reconcile. Use `/upload` for normal additive roster updates.

## Secret rotation

Rotate a compromised Discord token through the Discord Developer Portal, replace the deployment value, and restart. Rotate Resend credentials by creating a replacement key, updating the deployment, checking a controlled inbox with `/testmail`, and revoking the old key.

To rotate `VERIFICATION_CODE_SECRET`, stop the bot, generate a cryptographically random replacement of at least 32 characters, update the deployment, and restart. Existing verification challenges will no longer validate; members must request fresh codes. Email-based rate-limit and audit HMACs use the same secret, so rotation changes their identity across the existing retention window. Account claims and roster entries remain intact. Never print secrets into logs or commit them.

## Troubleshooting and rollback

Startup rejects incomplete configuration, unsafe roles, inaccessible channels, and invalid editable messages. Fix the named setting or message before retrying. SMTP timeouts are bounded, but SMTP acceptance does not establish inbox delivery; check a controlled inbox and junk folder.

Role assignment failures retain claims for `/roster repair` or reconciliation. Failed release operations retain role ownership for retry. Check the private administrator alert channel and logs before repeating account-management commands.

Shoot synchronization runs every minute and at reconnect. Keep recovery markers in channel topics and message footers intact. See [shoot recovery behavior](shoots.md). Abandoned setup drafts expire after 30 minutes and are removed at startup or hourly cleanup.

For rollback, stop the new bot and deploy the previous known-good commit against a compatible database. If a future migration is incompatible, restore the matching pre-upgrade snapshot rather than downgrading the schema in place. Never run the old and new bot concurrently.

The GitHub repository is `TheTexta/tvm-discord-bot`. Keep Coolify’s application UUID, service identity, and data volume when updating its Git source URL; renaming the source does not require creating a replacement application.
