# TVM Discord Bot

TVM’s Discord bot verifies members against an email roster, assigns membership roles, and manages private shoot workspaces. Each roster email links to one Discord account.

## Quick start

Requires Node.js 22.13+, a Discord bot, and a Resend key with a verified sending domain.

1. Copy `.env.example` to `.env.local` and fill in the values. Generate a random `VERIFICATION_CODE_SECRET` of at least 32 characters.
2. Enable **Server Members Intent** in the Discord Developer Portal. Install the bot with `bot` and `applications.commands` scopes.
3. Grant Manage Roles, View Channels, and Send Messages. Put the bot role above all membership roles and `Unverified`; configure a private administrator alert channel.

```sh
npm ci
npm run check
npm run discord:check
npm start
```

`npm start` loads `.env.local` when present; exported environment variables take precedence. The local database defaults to `./config/tvm.db`. Containers persist `/usr/app/config/tvm.db`. Run one replica.

Startup validates configuration, editable messages, roles, and channel permissions. Commands become available after initialization; `/source` remains available while starting.

## Membership

Members receive `General Member`. Editors/producers also receive `Executives (Producers & Editors)`; admins also receive `Admin Team`. Codes expire after 15 minutes and allow five attempts. Requests and sends are rate limited.

Upload a CSV with `Email,Role` headers. Accepted roles are `GM`, `Exec - Editor`, `Exec - Producer`, and `Admin`. Other columns are ignored. Limits: 2 MiB, 10,000 rows, and no duplicate emails.

```sh
npm run roster:check -- /path/to/eligible-members.csv
```

Uploads add members and update included tiers; omitted emails remain active. Automatic role revocation is disabled by default, and pre-existing roles remain outside the bot’s ownership. `Unverified` is assigned only to humans with no other roles.

## Common commands

Management commands require the configured Admin Team role or Discord Administrator permission.

| Command                                                                                     | Purpose                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `/verify`                                                                                   | Request a code for your roster email.       |
| `/source`                                                                                   | Open this bot’s source repository.          |
| `/upload`                                                                                   | Merge an eligible-member CSV.               |
| `/postverify`                                                                               | Publish the verification button.            |
| `/testmail`                                                                                 | Send a delivery test to a controlled inbox. |
| `/roster status`, `/roster audit`                                                           | Inspect roster status and changes.          |
| `/roster reconcile`, `/roster repair`                                                       | Retry membership role synchronization.      |
| `/roster transfer`, `/roster release`                                                       | Move or release a verified account claim.   |
| `/shoot setup`, `/shoot edit`, `/shoot crew`, `/shoot add`, `/shoot close`, `/shoot reopen` | Manage private shoot chats when configured. |

## Operator and contributor guides

- [Shoot setup, joining, and archival](docs/shoots.md)
- [Deployment, backups, recovery, and secret rotation](docs/operations.md)
- [Development and runtime boundaries](docs/development.md)
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md)

Edit `ui-text.json` to change wording, keeping its keys and placeholders intact. Restart or redeploy after editing; publish the updated verification post with `/postverify`. Recovery identifiers are fixed in code. Startup rejects invalid message keys, placeholders, and component lengths.

Based on [EmailVerify](https://github.com/lkaesberg/EmailVerify). Licensed under [AGPL-3.0-or-later](LICENSE); retain the license and upstream attribution. Historical upstream documentation is [archived](docs/upstream/README.md). Keep deployed source public; `/source` links to it.
