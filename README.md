# TVM Discord membership verification

This project is a TVM-specific fork of [EmailVerify](https://github.com/lkaesberg/EmailVerify), pinned to upstream commit `f8b20c46e4215940ccb1a8cea27a19002a860e17`. The running entry point is `src/tvm/App.js`; the original upstream implementation remains in `src/` for reference and license compliance but is **not** started by `npm start` or the Dockerfile. The original README is in [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md). The project is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE).

## What it does

Only a student number in the current TVM roster can initiate verification. The bot sends a six-digit code to the roster email and grants the configured `TVM Member` role after a valid code. Each roster entry can be claimed by one Discord account. There are no domain, arbitrary-email, or manual-verification role-grant paths in the TVM runtime.

Members can use `/source` to find the complete source of the deployed bot. Keep this repository public while operating the modified network service.

**Release requirement:** the GitHub repository is currently private. Publish the complete deployed source and confirm `/source` is accessible without a GitHub login before members use the bot.

Codes expire after 15 minutes, allow five attempts, and are stored as HMAC hashes. Requests are limited per Discord account and student number; sends also have a server-wide daily budget. All verification replies are private. The roster, claims, pending codes, and rate-limit events live in SQLite at `TVM_DATABASE_PATH`.

## Configure

Requires Node.js 22+, a dedicated Discord application, a Resend API key, a verified sending domain, a TVM server, and a `TVM Member` role. Copy `.env.example` as a reference and supply its values through your shell or Coolify environment settings. Never commit live values or the roster. `VERIFICATION_CODE_SECRET` should be a random secret of at least 32 characters, retained across redeployments. `SMTP_FROM` must be an address at a domain verified in Resend. Resend uses `smtp.resend.com:465`, SMTP username `resend`, and the API key as the password.

Use a dedicated Resend key for this bot and leave open and click tracking disabled for verification email. A verified subdomain of an operator-controlled domain is sufficient until TVM DNS access is available; `onboarding@resend.dev` is only a test sender.

Set the bot's role above `TVM Member` and grant it Manage Roles, View Channels, Send Messages, and Use Application Commands. Enable Server Members Intent in the Discord Developer Portal. Install with `bot` and `applications.commands` scopes. Make a private administrator alert channel and configure `TVM_ADMIN_ALERT_CHANNEL_ID` for failures. The bot only registers commands in `TVM_GUILD_ID`.

The roster CSV must contain `Student ID` and `Email` headers. **Export only eligible members.** Other columns are ignored; workshop/training fields do not change eligibility. Student numbers are read as text, so leading zeroes survive. A replacement is rejected if it is empty, malformed, has duplicate IDs or emails, or exceeds 2 MiB or 10,000 rows. Invalid replacements leave the active roster unchanged.

Check an export locally before uploading it. The checker prints row numbers and issue types without printing student numbers or email addresses:

```sh
npm run roster:check -- /path/to/eligible-members.csv
```

## Run locally

```sh
npm ci
npm test
TVM_DATABASE_PATH=./config/tvm.db npm start
```

Supply the required environment variables before `npm start`. There is deliberately no production roster or secret-bearing config file in this repository. Local tests use synthetic data and do not contact Discord or Resend.

## Admin workflow

1. Use `/testmail` to confirm delivery to a controlled inbox. Check junk as well as SMTP acceptance.
2. Use `/roster replace` with a CSV containing **only currently eligible members**. This atomically replaces the active roster, invalidates pending codes, and attempts to remove `TVM Member` from removed members. Review the reported failures.
3. Use `/roster status` to check the active version, row count, and unreconciled removals. Use `/roster reconcile` until the unreconciled count is zero.
   Use `/roster audit` to review recent roster replacements and account transfers.
   Reconciliation also removes `TVM Member` from accounts without an active roster-backed claim, including manually granted roles.
   A member update listener checks new role grants immediately; the hourly reconciliation catches missed events.
4. Use `/postverify` in the unverified members' channel. Use a normal account to test that member channels require `TVM Member`.
5. Use `/roster transfer` when a verified member changes Discord accounts. Both accounts must be in the server, and the target must not already claim another roster entry.
6. If Discord could not confirm a role assignment, use `/roster repair` for that student's active claim after checking the bot's permissions.
7. Use `/roster release` to remove a role and unlink a claim when a member requests deletion or an erroneous claim must be cleared. The member can verify again while still in the active roster.

Pending codes expire after 15 minutes and are swept hourly. Request events are kept for at most an hour, sending events for at most a day, and administrator audit entries for up to one year. Active roster entries and claims remain until a roster replacement, revocation, transfer, or release changes them. Database backups may retain older copies until the backup retention period ends.

The bot stores the roster in SQLite after import; the uploaded CSV does not need a separate persistent mount. Back up the **entire** `tvm.db` database with SQLite's backup API or `sqlite3 .backup`, and keep an encrypted copy off the Coolify server. Test a restore before rollout. A volume is persistence, not a backup. Keep the old sender domain and key available until a replacement sender passes `/testmail`; then update `SMTP_FROM` and `RESEND_API_KEY` and redeploy. Rotate the Discord token and verification secret through Coolify; changing the latter invalidates pending codes.

## Coolify deployment

Deploy this repository as a Docker Compose application using [docker-compose.yml](docker-compose.yml). Configure all required environment variables as secrets. Keep one replica: SQLite and the in-process membership lock are designed for one bot process. The named `tvm_data` volume persists `/usr/app/config/tvm.db` across redeployments. No public port or HTTP route is needed. Back up this volume off server and monitor logs and the private alert channel.

Before production rollout, verify the current Resend sending allowance and stage member invitations accordingly. Production smoke tests require real Discord, Resend, DNS, roster, and Coolify access; none are included in this repository.
