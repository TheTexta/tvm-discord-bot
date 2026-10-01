# TVM Discord email verification plan

## Goal

Run a TVM-specific [EmailVerify](https://github.com/lkaesberg/EmailVerify) fork on Coolify. A member privately enters the **email address on the TVM member roster**. The bot sends a one-time code to that address and grants `General Member` after the code is accepted. Editors and producers also receive `Executives (Producers & Editors)`; admins also receive `Admin Team`. Student numbers do not participate in lookup, verification, claims, or rate limits. A domain match alone does not establish membership.

The complete source of the running bot is public at [TheTexta/tvm-discord-email-verification](https://github.com/TheTexta/tvm-discord-email-verification), and the bot exposes it with `/source`. Never commit the real roster, credentials, or database. Preserve the upstream AGPL license and attribution.

## Progress as of 2026-10-01

- The email-only TVM runtime, roster parser, claim database, administrator commands, Resend SMTP integration, Dockerfile, Compose example, and local tests are implemented. The original EmailVerify code remains in the repository but is not the running entry point.
- Discord credentials work. The bot has joined the TVM server; Server Members Intent, role hierarchy, Manage Roles, and private alert-channel access pass `npm run discord:check`.
- Cloudflare serves the sending domain's DKIM and return-path records. Resend SMTP accepted a message from `verify@tvm.dextery.dev` to its delivery test address. Confirm the domain's `Verified` status in Resend and test a real controlled inbox before inviting members.
- A Coolify Dockerfile application is running with a dedicated read-only GitHub deploy key, runtime secrets, and a persistent mount at `/usr/app/config`. The email-based Discord commands are registered.
- The F26 master file has 103 data rows. A roster with 102 unique addresses and their role tiers is active as version 2: 67 GM, 24 Exec, and 11 Admin. It includes the 12 rows without student numbers and excludes row 74's alternate email, following TVM's earlier choice of row 15's email. The CSV remains outside Git and was removed from the container after import.
- An encrypted copy of the current SQLite database was saved off server and decrypted into a temporary file to check integrity, roster count, version, and the role-ownership schema.
- Initial reconciliation affected existing `General Member` assignments. Every affected assignment was restored from Discord's audit trail and confirmed present after deploying the corrected runtime. The bot now tracks whether it granted each role and preserves pre-existing assignments.

## Membership and verification rules

1. Import only current TVM members. The CSV requires `Email` and `Role` headers; other columns are ignored. Accepted roles are GM, Exec Editor, Exec Producer, and Admin. Trim and lowercase addresses for exact lookup. Reject empty, malformed, duplicate, unknown-role, or oversized replacements before changing the active roster.
2. `/verify` and the verification button open a private email modal. Respond generically whether an address is listed, so the bot does not reveal roster membership.
3. Limit requests per Discord account and submitted email and cap server-wide sends. Store short-lived rate-limit keys as HMACs instead of raw submitted addresses.
4. If the email is active, send a six-digit code to that same address. Bind its HMAC to the Discord account, server, email, and roster version. Expire it after 15 minutes and allow at most five attempts.
5. Recheck the active roster and account claim before granting General Member and the matching Exec or Admin role. One roster email can be claimed by one Discord account, and one account can claim one roster email. Only administrators can release or transfer claims.
6. On roster replacement, invalidate pending codes and sync roles for active claims. Revoke a role only when the bot granted it for a removed or downgraded claim. Existing role assignments made outside this bot remain intact. Reconcile failed bot-managed role changes at startup and hourly.
7. Administrators can upload a complete replacement CSV with `/upload`; `/roster replace` uses the same validation and update path. Google Sheet edits require an upload until an authenticated sheet sync is configured.

## Deployment and rollout

1. Run `npm test`, `npm run roster:check -- /path/to/eligible-members.csv`, and `npm run discord:check`. Keep the roster CSV outside Git.
2. Confirm Resend shows `tvm.dextery.dev` as verified, then send `/testmail` to a controlled inbox and check delivery and junk placement. Keep click and open tracking disabled for codes. [Resend domain guide](https://resend.com/docs/add-a-domain)
3. Keep one Coolify replica and no public HTTP route. Persist the SQLite database at `/usr/app/config/tvm.db` and continue encrypted off-server backups. [Coolify persistent storage](https://coolify.io/docs/core/persistent-storage/storage-mounts/overview)
4. Pilot with administrators and a small set of roster addresses. Run `/roster status` and `/roster reconcile` until there are no outstanding role changes.
5. Post the verification button in the unverified channel. Test with a normal Discord account that valid roster email plus code grants the correct roles, while an absent email, wrong code, or already claimed email does not. Test that unverified members cannot access member channels.
6. Verify restart and redeploy preserve roster and claims. Confirm `/source` opens without a GitHub login. Monitor Coolify logs and the private administrator alert channel.

## Acceptance checks

| Scenario | Expected result |
| --- | --- |
| Active roster email and correct code | `General Member` plus the matching Exec or Admin role granted once |
| Email absent from roster | No code sent and no role granted; generic private response |
| Wrong, expired, reused, or stale-version code | Rejected |
| Second Discord account uses a claimed email | Administrator transfer required |
| Member email removed or tier downgraded | Bot-granted roles are revoked; pre-existing role assignments remain |
| Invalid or empty roster replacement | Previous active roster remains intact |
| SMTP or Discord role error | No false success; administrator alerted |
| Restart, redeploy, and backup restore | Roster and claims remain consistent |
