# TVM Discord membership verification

This project is a TVM-specific fork of [EmailVerify](https://github.com/lkaesberg/EmailVerify), pinned to upstream commit `f8b20c46e4215940ccb1a8cea27a19002a860e17`. The running entry point is `src/tvm/App.js`; the original upstream implementation remains in `src/` for reference and license compliance but is **not** started by `npm start` or the Dockerfile. The original README is in [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md). The project is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE).

## What it does

Only an email address in the current TVM roster can initiate verification. A member privately enters that email and receives a six-digit code at the same address. After entering the code, everyone receives `General Member`; `Exec - Editor` and `Exec - Producer` receive `Executives (Producers & Editors)` too; `Admin` receives `Admin Team` too. Each roster email can be claimed by one Discord account. Student numbers are not used. There are no domain-wide or manual-verification role-grant paths in the TVM runtime.

Members can use `/source` to find the complete source of the deployed bot. Keep this repository public while operating the modified network service.

Human members with only `@everyone` receive a mentionable `Unverified` role. The bot checks existing members on startup and hourly, and handles joins and role changes as they occur. It removes `Unverified` after verification or any other role assignment; members who already have another role and bots are excluded. Administrators can write their own message mentioning `@Unverified` to invite these members to verify. The bot does not post reminders automatically. Use `/roster reconcile` to retry failed assignments.

Codes expire after 15 minutes, allow five attempts, and are stored as HMAC hashes. Requests are limited per Discord account and submitted email; sends also have a server-wide daily budget. Rate-limit events store an HMAC of the email. All verification replies are private. The roster, claims, pending codes, and rate-limit events live in SQLite at `TVM_DATABASE_PATH`.

## Configure

Requires Node.js 22+, a dedicated Discord application, a Resend API key, a verified sending domain, and a TVM server. Configure `TVM_MEMBER_ROLE_ID`, `TVM_EXEC_ROLE_ID`, and `TVM_ADMIN_ROLE_ID` for `General Member`, `Executives (Producers & Editors)`, and `Admin Team`. Copy `.env.example` as a reference and supply its values through your shell or Coolify environment settings. Never commit live values or the roster. `VERIFICATION_CODE_SECRET` should be a random secret of at least 32 characters, retained across redeployments. `SMTP_FROM` must be an address at a domain verified in Resend. Resend uses `smtp.resend.com:465`, SMTP username `resend`, and the API key as the password.

Use a dedicated Resend key for this bot and leave open and click tracking disabled for verification email. A verified subdomain of an operator-controlled domain is sufficient until TVM DNS access is available; `onboarding@resend.dev` is only a test sender.

Set the bot's role above all three configured roles and `Unverified` and grant it Manage Roles, View Channels, Send Messages, and Use Application Commands. Enable Server Members Intent in the Discord Developer Portal. Install with `bot` and `applications.commands` scopes. Make a private administrator alert channel and configure `TVM_ADMIN_ALERT_CHANNEL_ID` for failures. The bot only registers commands in `TVM_GUILD_ID`.

Optionally set `TVM_UNVERIFIED_ROLE_ID` to an existing role. Otherwise the bot reuses the single role named `Unverified`, or creates it with no permissions and mentions enabled. The role must have no permissions, be separate from the membership roles, and sit below the bot. Multiple roles with that name require an explicit ID.

After filling `.env.local` locally, run `npm run discord:check` to check the application, member intent, server installation, role hierarchy, and alert-channel access without printing credentials. This check makes no Discord changes. It does not test mail delivery.

The roster CSV must contain `Email` and `Role` headers. **Include only eligible members in new rows.** Accepted roles are `GM`, `Exec - Editor`, `Exec - Producer`, and `Admin` (`Exec: Editor` and `Exec: Producer` also work). Other columns, including `Student ID`, are ignored; rows with blank student numbers can verify. Workshop/training fields do not change eligibility. Emails are trimmed and compared without case. An upload is rejected if it is empty, malformed, has duplicate emails or unknown roles, or exceeds 2 MiB or 10,000 rows. Invalid uploads leave the active roster unchanged.

Check an export locally before uploading it. The checker prints row numbers and issue types without printing email addresses:

```sh
npm run roster:check -- /path/to/eligible-members.csv
```

For a new deployment, an operator with private host access can import the first roster directly into the persistent database with `node scripts/import-initial-roster.js /path/to/eligible-members.csv EXPECTED_COUNT` inside the application container. It refuses to replace an existing roster; use `/upload` to add or update entries later. Remove the temporary CSV from the host and container after import.

## Run locally

```sh
npm ci
npm test
TVM_DATABASE_PATH=./config/tvm.db npm start
```

Supply the required environment variables before `npm start`. There is deliberately no production roster or secret-bearing config file in this repository. Local tests use synthetic data and do not contact Discord or Resend.

## Admin workflow

1. Use `/testmail` to confirm delivery to a controlled inbox. Check junk as well as SMTP acceptance.
2. Download the current roster tab as CSV, then use the admin-only `/upload` command and attach it as `csv`. Uploading **adds new emails and updates roles for included emails**. Emails omitted from the CSV stay active, so an incomplete sheet does not remove anyone. Existing Discord roles are preserved; eligible new roles are granted to verified accounts. A valid upload invalidates pending codes. Review any reported role-sync failures.
3. Use `/roster status` to check the active version and row count. Use `/roster reconcile` to retry missing role grants, and `/roster audit` to review recent uploads and account transfers.
   Reconciliation updates active claims and retries missing role grants. Automatic role revocation is disabled while TVM's roster is incomplete; it can be enabled later with `TVM_AUTO_ROLE_REVOCATION=true` after a complete roster and a reviewed replacement process are in place. `/roster release` and `/roster transfer` remain explicit administrator actions that can remove bot-managed roles.
4. Use `/postverify` in the unverified members' channel. Use a normal account to test that member channels require the configured membership role.
5. Use `/roster transfer` when a verified member changes Discord accounts. Both accounts must be in the server, and the target must not already claim another roster entry.
6. If Discord could not confirm a role assignment, use `/roster repair` with that email's active claim after checking the bot's permissions.
7. Use `/roster release` to remove a role and unlink a claim when a member requests deletion or an erroneous claim must be cleared. The member can verify again while still in the active roster.

Pending codes expire after 15 minutes and are swept hourly. Request events are kept for at most an hour, sending events for at most a day, and administrator audit entries for up to one year. Active roster entries and claims remain until a deliberate removal, transfer, or release changes them. Database backups may retain older copies until the backup retention period ends.

The bot stores the roster in SQLite after import; the uploaded CSV does not need a separate persistent mount. Back up the **entire** `tvm.db` database with SQLite's backup API or `sqlite3 .backup`, and keep an encrypted copy off the Coolify server. Test a restore before rollout. A volume is persistence, not a backup. Keep the old sender domain and key available until a replacement sender passes `/testmail`; then update `SMTP_FROM` and `RESEND_API_KEY` and redeploy. Rotate the Discord token and verification secret through Coolify; changing the latter invalidates pending codes.

## Coolify deployment

Deploy this repository as a Coolify Dockerfile application, or as a Docker Compose application using [docker-compose.yml](docker-compose.yml). For a Dockerfile application, attach persistent storage at `/usr/app/config` before the first deployment. For Compose, the named `tvm_data` volume provides that mount. Configure all required environment variables as runtime secrets. Keep one replica: SQLite and the in-process membership lock are designed for one bot process. The database is `/usr/app/config/tvm.db`. No public port or HTTP route is needed. Back up the volume off server and monitor logs and the private alert channel.

Before production rollout, verify the current Resend sending allowance and stage member invitations accordingly. Production smoke tests require real Discord, Resend, DNS, roster, and Coolify access; none are included in this repository.
