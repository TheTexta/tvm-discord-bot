# Development

Use Node.js 22.13 or later and install the lockfile with `npm ci`.

```sh
npm run check
npm audit --omit=dev --audit-level=moderate
```

`npm run check` runs lint, formatting validation, and the tests. Use `npm run format` to apply the repository's formatting. Tests use temporary SQLite databases and Discord/mail adapters; no live credentials are needed.

## Runtime boundaries

- `src/tvm/index.js` owns environment loading, dependency construction, login, and process signals.
- `src/tvm/App.js` exports `createApp` with injected configuration, store, mail, client, and optional adapters. Importing it does not open a database or connect to Discord.
- `VerificationService.js` owns challenges and delivery; `RosterCommands.js` owns roster and account management commands.
- `MembershipService.js` owns membership role reconciliation and preserves ownership of pre-existing roles.
- `Store.js` serializes database access; `_transaction` runs within that queue or during initialization. Operational scripts use public methods.
- `migrations.js` records numbered, transactional migrations in `tvm_schema_migrations`. Earlier unversioned TVM databases are upgraded in place. Existing shoots retain unlimited joining unless edited. Do not edit applied migrations; append a new version.
- `shoot/forms.js`, `shoot/render.js`, and `shoot/policy.js` contain presentation and pure rules. `ShootService.js` owns synchronization, reaction membership, and durable resource recovery.
- `validation.js`, `roles.js`, and `roster.js` provide shared validation for the runtime and maintenance scripts.

Verification reserves a send and saves the challenge under the membership lock before SMTP delivery. Delivery uses a separate queue per Discord account, so unrelated membership work can continue. A concurrent roster upload, release, or transfer invalidates the saved challenge; delivery never recreates it. If SMTP loses a successful response, its short-lived challenge remains usable, with the same rate and attempt limits.

SIGTERM/SIGINT stop incoming work and timers, drain accepted work, close mail and SQLite, and destroy the Discord client. Shutdown has a 25-second deadline. Compose allows 30 seconds before killing the container. Run one replica; process-local locks are not a multi-replica coordination mechanism.

## Container checks

```sh
docker build -t tvm-verification:test .
docker run --rm tvm-verification:test node scripts/check-container.js
```

The smoke check exercises native SQLite, migrations, persistence permissions, and import-safe startup as the runtime user. CI builds and checks the image independently of local tests. Compilation uses Debian bookworm in both stages to preserve native-binding compatibility.

The container runs as UID/GID 1000. A new data volume is writable by that user. For an existing deployment whose volume is owned by root, update `/usr/app/config` ownership to UID/GID 1000 before deploying. Preserve restrictive database permissions and take a SQLite backup first.

The inherited EmailVerify site is retained under `docs/upstream` for historical reference. It is not the TVM operator guide.
