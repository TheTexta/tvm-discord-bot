# TVM Discord verification

Members verify with a six-digit code sent to their roster email. Everyone gets `General Member`; editors/producers also get `Executives (Producers & Editors)`, and admins also get `Admin Team`. Each email links to one Discord account.

## Setup

Requires Node.js 22+, a Discord bot, and a Resend key with a verified sending domain.

1. Copy `.env.example` to `.env.local` and fill in the values. Use a random secret of at least 32 characters for `VERIFICATION_CODE_SECRET`.
2. Enable **Server Members Intent** in the Discord Developer Portal. Install the bot with `bot` and `applications.commands` scopes.
3. Give the bot Manage Roles, View Channels, and Send Messages. Put its role above the three membership roles and `Unverified`. Set a private admin alert channel.

```sh
npm ci
npm test
npm run discord:check
TVM_DATABASE_PATH=./config/tvm.db node --env-file=.env.local src/tvm/App.js
```

## Edit text

Edit [ui-text.json](ui-text.json) for all bot messages, buttons, modals, command descriptions, emails, and admin alerts/errors. Keep the keys and `{placeholders}` intact. Restart the bot after editing; redeploy for Docker/Coolify. Use `/postverify` again to publish updated text.

Discord limits: command descriptions 100 characters, button labels 80, modal titles/input labels 45. Membership role names here are display text; if changing the `Unverified` name, set `TVM_UNVERIFIED_ROLE_ID` to keep using the existing role.

## Admin commands

| Command | Purpose |
| --- | --- |
| `/testmail` | Check delivery to a controlled inbox, including junk. |
| `/upload` | Attach a roster CSV to add emails and update roles. Omitted emails stay active; existing roles are preserved. |
| `/postverify` | Post the public verification button. |
| `/roster status` | Check roster size and version. |
| `/roster reconcile` | Retry role synchronization. |
| `/roster audit` | Review uploads and account changes. |
| `/roster repair` | Retry role assignment for a claimed email. |
| `/roster transfer` | Move a claim to another Discord account. |
| `/roster release` | Unlink a claim and remove bot-managed roles. |

CSV headers: `Email,Role`. Roles: `GM`, `Exec - Editor`, `Exec - Producer`, `Admin`. Include eligible members only. Other columns are ignored. Limits: 2 MiB, 10,000 rows, no duplicate emails.

```sh
npm run roster:check -- /path/to/eligible-members.csv
```

The bot assigns `Unverified` to humans with no other roles. Admins can mention it in their own reminders. Codes expire after 15 minutes. Automatic role revocation is disabled by default.

## Deploy

Use the Dockerfile or [docker-compose.yml](docker-compose.yml) in Coolify. Set the environment variables, run one replica, and persist `/usr/app/config`. No public port is needed. Back up `tvm.db` with SQLite's backup API or `.backup`. Keep secrets and roster files out of Git.

Based on [EmailVerify](https://github.com/lkaesberg/EmailVerify). [AGPL-3.0-or-later](LICENSE); [original README](docs/UPSTREAM_README.md). Keep the deployed source public; `/source` links to it.
