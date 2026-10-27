# Development

Use Node.js 22.13 or later and install the lockfile with `npm ci`.

```sh
npm run check
npm audit --omit=dev --audit-level=moderate
```

`npm run check` runs lint, formatting validation, and the tests. Use `npm run format` to apply the repository's formatting. Tests use temporary SQLite databases and Discord/mail adapters; no live credentials are needed.

## Runtime boundaries

- `src/app` owns configuration, dependency construction, event wiring, startup, and shutdown. `createApp` remains dependency-injected and import-safe. `src/tvm/index.js` and `src/tvm/App.js` are compatibility entrypoints for existing operator commands.
- `src/membership` owns roster snapshots, identity links, verification, role ownership, and role synchronization. Reconciliation locks one account at a time and rereads current roster data before acting; the upload transaction uses the same lock. Scans and upload downloads do not hold it across the entire operation.
- `src/shoots` owns command handling, forms, joining policy, rendering, and reactions. `ShootResources` owns message/channel recovery and publication. Recovery topics, footers, and modal IDs preserve their deployed formats.
- `ShootFailureReporter` owns safe diagnostics and process-local incident/grace/recovery state. Async-local attempt context isolates concurrent shoots; operation annotations preserve original error identities and Discord codes. Expected `ShootInputError` rejections are private feedback in command handling, but remain operational failures when encountered during background reconciliation. `AdminAlerts` coalesces concurrent sends and starts its cooldown only after delivery. Reporter tests exercise the real reporting path, not only the legacy shoot fixture's reporting stub.
- `src/infrastructure` owns one SQLite connection, its queue, lifecycle, numbered migrations, SMTP, and health reporting. Membership and shoot repositories share that connection. `Store` is the lifecycle owner and compatibility facade; production services receive focused repositories.
- `src/shared` owns text rendering, validation, authorization, and channel privacy calculation. Editable text keys/placeholders are declared in `src/shared/uiTextSchema.json`.
- Shoot tests are grouped into forms, reactions, lifecycle, recovery, and reliability suites with shared Discord fixtures under `test/helpers`.

Each accepted CSV transaction replaces eligibility and tiers, increments the version, clears pending codes, and audits aggregate differences. Migration 7 marks legacy merged rosters as non-authoritative until the first complete upload. Earlier applied migrations are unchanged. Append future migrations rather than editing applied ones.

Verification establishes an identity link without claiming ownership of existing roles. Ownership intent is persisted immediately before adding a missing role, so an ambiguous Discord failure remains repairable. Successful removal clears only that role's ownership flag. CSV omission retains the identity link; explicit release/transfer changes account linkage. Unknown ownership is never inferred from possession or verification.

Verification checks input, availability, and request limits, then delivers generic feedback before any eligibility lookup, send reservation, or account delivery queue. If acknowledgement fails, no challenge is prepared or email sent. The tracked operation continues after acknowledgement: it reserves a send and saves the challenge under the membership lock before SMTP delivery. Delivery uses a separate queue per Discord account, so unrelated membership work and later generic acknowledgements can continue. A concurrent confirmed roster replacement, release, or transfer invalidates the saved challenge; delivery never recreates it. Post-acknowledgement lookup/SMTP errors alert operators without editing member feedback or logging destination-bearing exception text. Shutdown still drains accepted deliveries.

Upload downloads and preview preparation are serialized in arrival order. Previews are process-local, limited to one per admin and 20 overall, expire after 10 minutes, and contain parsed rows rather than re-downloading the attachment at confirmation. Buttons bind the admin, guild, and channel and recheck authorization. Confirmation uses the membership lock and an expected-version check inside the SQLite replacement transaction; concurrent or stale confirmations cannot overwrite a newer roster. Consumed previews are discarded even if confirmation delivery fails. Restart/shutdown discard pending previews. No schema change is required.

`withAdminOperation` tracks saved, synchronization-pending, and completed outcomes independently of Discord reply state. Roster replacement, repair, release, transfer, verification-post publication, and test mail preserve accepted outcomes when only their confirmation fails. Saved transfers/releases schedule reconciliation even if later immediate synchronization fails.

Reconciliation is coalesced, reports progress, and repeats if a newer snapshot arrived during the scan. Member joins restore the current tier immediately. Reconnect schedules both membership and shoot synchronization. Reaction events debounce for 250 ms and mark a running pass dirty when more events arrive.

Shoot setup/edit prepares a cached, user/channel-bound form after deferring the interaction. Its button shows the modal without database I/O; submission checks database state and permissions. A restart invalidates cached buttons, while persisted drafts expire normally. Expired drafts and participant rows are swept transactionally.

Each shoot command or per-shoot reconciliation pass reuses its own fresh member lookup promises across reaction eligibility, capacity, archive permissions, and private-brief rendering. Results and missing members never carry into another shoot or trailing/retry pass. Transient fetch errors are evicted. No global or long-lived permission cache is used; role changes are rechecked on the next pass. The 22-participant regression fixture requires 21 fetches for an open pass and 22 for an archived pass, versus 63 and 85 previously.

SIGTERM/SIGINT stop incoming work and timers, flush accepted reaction jobs, drain accepted work, write a stopping heartbeat, close mail and SQLite, and destroy the Discord client. Shutdown has a 25-second deadline. Compose allows 30 seconds. Run one replica; process-local locks do not coordinate replicas or maintenance scripts.

## Container checks

```sh
docker build -t tvm-discord-bot:test .
docker run --rm tvm-discord-bot:test node scripts/check-container.js
```

The smoke check exercises native SQLite, snapshot migration, persistence permissions, synthetic healthcheck reporting, and import-safe startup as the runtime user. CI builds and checks the image independently of local tests. Compilation uses Debian bookworm in both stages to preserve native-binding compatibility.

The container runs as UID/GID 1000. A new data volume is writable by that user. For an existing deployment whose volume is owned by root, update `/usr/app/config` ownership to UID/GID 1000 before deploying. Preserve restrictive database permissions and take a SQLite backup first.

The inherited EmailVerify site is retained under `docs/upstream` for historical reference. It is not the TVM operator guide.

Editable-message keys and placeholders are declared in `src/shared/uiTextSchema.json`. Update that contract alongside intentional message additions; wording-only changes must preserve it. Shoot recovery identifiers keep their deployed format and are not editable copy. Expired setup drafts and their participant rows are removed transactionally at startup and hourly.
