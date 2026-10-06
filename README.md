# TVM Discord verification

Members verify with a six-digit code sent to their roster email. Everyone gets `General Member`; editors/producers also get `Executives (Producers & Editors)`, and admins also get `Admin Team`. Each email links to one Discord account.

## Setup

Requires Node.js 22.13+, a Discord bot, and a Resend key with a verified sending domain.

1. Copy `.env.example` to `.env.local` and fill in the values. Use a random secret of at least 32 characters for `VERIFICATION_CODE_SECRET`.
2. Enable **Server Members Intent** in the Discord Developer Portal. Install the bot with `bot` and `applications.commands` scopes.
3. Give the bot Manage Roles, View Channels, and Send Messages. Put its role above the three membership roles and `Unverified`. Set a private admin alert channel.

```sh
npm ci
npm test
npm run discord:check
TVM_DATABASE_PATH=./config/tvm.db node --env-file=.env.local src/tvm/index.js
```

## Development

Run `npm run check` for lint, formatting, and tests. See [development.md](docs/development.md) for runtime boundaries, migrations, shutdown, and container checks. Historical upstream documentation is archived under [docs/upstream](docs/upstream/README.md).

## Edit text

Edit [ui-text.json](ui-text.json) for all bot messages, buttons, modals, command descriptions, emails, and admin alerts/errors. Keep the keys and `{placeholders}` intact. Restart the bot after editing; redeploy for Docker/Coolify. Use `/postverify` again to publish updated text.

Discord limits: command descriptions 100 characters, button labels 80, modal titles/input labels 45. Membership role names here are display text; if changing the `Unverified` name, set `TVM_UNVERIFIED_ROLE_ID` to keep using the existing role.

## Admin commands

The configured Admin Team role (`TVM_ADMIN_ROLE_ID`) and Discord Administrator permission grant equal access to all bot management commands.

| Command             | Purpose                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/testmail`         | Check delivery to a controlled inbox, including junk.                                                         |
| `/upload`           | Attach a roster CSV to add emails and update roles. Omitted emails stay active; existing roles are preserved. |
| `/postverify`       | Post the public verification button.                                                                          |
| `/roster status`    | Check roster size and version.                                                                                |
| `/roster reconcile` | Retry role synchronization.                                                                                   |
| `/roster audit`     | Review uploads and account changes.                                                                           |
| `/roster repair`    | Retry role assignment for a claimed email.                                                                    |
| `/roster transfer`  | Move a claim to another Discord account.                                                                      |
| `/roster release`   | Unlink a claim and remove bot-managed roles.                                                                  |

CSV headers: `Email,Role`. Roles: `GM`, `Exec - Editor`, `Exec - Producer`, `Admin`. Include eligible members only. Other columns are ignored. Limits: 2 MiB, 10,000 rows, no duplicate emails.

```sh
npm run roster:check -- /path/to/eligible-members.csv
```

The bot assigns `Unverified` to humans with no other roles. Admins can mention it in their own reminders. SMTP connection, greeting, and DNS waits are capped at 10 seconds each, with a 20-second idle socket timeout. Codes expire after 15 minutes. Automatic role revocation is disabled by default.

## Shoot workspaces

TVM can create and manage private shoot chats independently of Ticket Tool. Ticket Tool can continue handling other tickets; TVM never edits its channels.

To enable shoots, create one ordinary text channel for invitations, one category for active shoots, and one category for archived shoots. Set all three IDs in `.env.local` or Coolify:

```dotenv
TVM_SHOOT_ANNOUNCEMENT_CHANNEL_ID=
TVM_SHOOT_CATEGORY_ID=
TVM_SHOOT_ARCHIVE_CATEGORY_ID=
```

Leave all three unset to keep shoots disabled. Partial configuration is rejected. The announcement channel should be readable by eligible members and allow them to add reactions. Deleting an invitation stops reaction joining for that shoot; existing participants keep access.

Give the bot View Channels, Read Message History, Send Messages, Embed Links, Add Reactions, and Manage Messages in the invitation channel. In both categories it needs View Channels, Read Message History, Send Messages, Send Messages in Threads, Add Reactions, Embed Links, Attach Files, Manage Channels, Manage Permissions (Manage Roles), and **Pin Messages**. Run `npm run discord:check` and restart/redeploy to register `/shoot`. No new privileged intent or Message Content Intent is needed.

All TVM management commands and shoot form submissions allow the configured **Admin Team** role (`TVM_ADMIN_ROLE_ID`) or Discord **Administrator** permission. This includes shoot setup/edit/crew/add/close/reopen, roster upload and all roster operations, posting verification, and test mail. Role membership is checked by ID, not display name, on every interaction. Command defaults allow role-based access; the bot rejects unauthorized users privately. The shoot creator becomes the organizer and retains access.

| Command                  | Purpose                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/shoot setup [members]` | Run in any server text channel. Optionally @mention up to 70 members, then enter the shoot name, Toronto call time, and location. Creates a new private chat and shared invitation. |
| `/shoot edit`            | Update the details and joining window; updates the pinned brief and invitation.                                                                                                     |
| `/shoot crew`            | Privately show directly invited and reaction-joined participants.                                                                                                                   |
| `/shoot add user`        | Add an eligible member to an open shoot, including after reaction joining expires.                                                                                                  |
| `/shoot close`           | Move the chat to the archive category, preserve participant reading access, and disable posting and new joins.                                                                      |
| `/shoot reopen`          | Return the chat to the active category and restore eligible members' access.                                                                                                        |

The setup/edit form has separate optional date (`YYYY-MM-DD`) and time (`HH:mm`) fields in `America/Toronto`. A date with a blank time uses **12:00 pm (noon)**. A blank date makes the shoot **Unscheduled**; the time is ignored. Discord displays scheduled call times in each viewer's local timezone. Invalid dates, daylight-saving gaps, and repeated daylight-saving times are rejected. Setup forms expire after 30 minutes; stale edit forms must be reopened.

The reaction joining dropdown offers **1 day** (default), **2 days**, **Week** (7 days), **Month** (30 days), and **Never**. The window starts when the shared invitation is first published and is independent of the call time. After expiry, the shoot stays open and existing members keep access; new members require an admin to use `/shoot add user`. Members can still remove their reaction to leave. Joining is blocked at the deadline; the invitation displays its expired state on the next synchronization (within about a minute). Changing the period through `/shoot edit` recalculates the deadline from the original publication time. Reopening does not reset it. Existing shoots created before this feature keep unlimited joining until an admin edits their window.

Directly invited members join immediately. Their display names appear only in the pinned shoot-channel brief; announcements do not list or ping them. Initial invitations cannot be removed through the bot; admins can add further direct invitations with `/shoot add user`. The setup admin is the organizer and retains access. Other verified members react **🎬** on the shared invitation to join, and remove it to leave. Reacting is membership in the chat, not attendance confirmation. Bots cannot join. Eligibility uses an active roster-linked verification, the configured Admin Team role, or Discord Administrator permission. It is rechecked during synchronization; an account that becomes ineligible loses participant access. The organizer retains access.

TVM uses explicit channel overwrites: participants, the bot, Admin Team, and Discord administrators can see shoot chats; category permissions are not copied. Admin Team can manage every active and archived shoot. Archived chats are read-only for ordinary participants; Admin Team retains posting and command access, and Discord administrators bypass overwrites. Shoot chats do not permit participant-created threads. There is a conservative maximum of 98 participants, including the organizer.

Shoot state survives restarts in `tvm.db`. The bot reconciles reaction changes on startup, reconnect, and every minute, and retries interrupted creation or synchronization. Recovery markers in channel topics and message footers identify resources whose Discord response was lost; keep those markers intact. Deleted pinned briefs are recreated. Routine synchronization and reaction events do not recreate deleted announcements. A shoot edit, reopening, or bot startup may republish an announcement without pinging participants or resetting its original joining deadline. Closed-shoot announcements are automatically deleted 24 hours after closing, on the next synchronization (within about a minute); interrupted deletions retry. For older closed shoots, the existing announcement’s last edit time is used as the close time. Closed announcements whose 24-hour cleanup is due stay deleted through edits and restarts; reopening can republish them. While an announcement is gone, existing membership remains and admins can add people with `/shoot add` in an open chat. A deleted shoot channel is marked missing and reported to admins; it is not automatically recreated. Recovery errors appear in the existing admin alert channel and bot logs.

This release includes no reminders, attendance tracking, production responsibilities, links, or shoot list command. Before enabling on the production server, verify with an admin and test members that outsiders cannot see chats, reaction joins/leaves work, direct invitations retain access, and closing produces a readable archive with posting disabled.

## Deploy

The container runs as UID/GID 1000. Before upgrading a deployment with an existing root-owned data volume, update `/usr/app/config` ownership to UID/GID 1000; see [container checks and volume migration](docs/development.md#container-checks).

Use the Dockerfile or [docker-compose.yml](docker-compose.yml) in Coolify. Set the environment variables, run one replica, and persist `/usr/app/config`. No public port is needed. Back up `tvm.db` with SQLite's backup API or `.backup`. Keep secrets and roster files out of Git.

Based on [EmailVerify](https://github.com/lkaesberg/EmailVerify). [AGPL-3.0-or-later](LICENSE); [original README](docs/upstream/UPSTREAM_README.md). Keep the deployed source public; `/source` links to it.
