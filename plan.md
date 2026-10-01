# TVM Discord membership verification plan

## Progress as of 2026-09-30

The pinned upstream source, TVM-only bot runtime, roster import and claims database, Resend SMTP configuration, Coolify Compose file, administrator commands, documentation, and local tests are implemented and pushed to the private GitHub repository. The Discord bot token and application ID were validated against Discord, and the bot has joined the TVM server. Server Members Intent is enabled in limited mode, and the bot role is above the configured `General Member` role. The new `npm run discord:check` command passes, including access to the administrator alert channel. The Resend key authenticates to SMTP, and a smoke-test message from `verify@tvm.dextery.dev` was accepted for Resend's delivery test address. The sender and a generated verification-code secret are stored in the ignored `.env.local` file. Cloudflare is now serving the domain's Resend DKIM and return-path records. The sending-only key cannot list Resend domains, so confirm sending status is `Verified` in the Resend dashboard and test a real inbox. Coolify currently has only a public GitHub source connection, while this repository remains private. Production setup and end-to-end tests also await the final roster eligibility policy. The F26 master CSV in Downloads has 103 rows: 12 lack student numbers, and one student number is duplicated with different emails. TVM selected the Exec - Editor row's email for that duplicate; the treatment of rows without IDs and the full eligibility rule still need confirmation.

A protected 90-entry candidate roster is prepared at `/Users/dexteryoung/.local/share/tvm-discord-email-verification/roster-candidate.csv`, based on including every row with a valid student number and preferring row 15 for the duplicate. It has not been imported. The GitHub repository is private, so publishing the deployed source remains part of the release gate.

## Goal

Self-host a TVM-specific fork of [EmailVerify](https://github.com/lkaesberg/EmailVerify) on Coolify. A member enters a student number in a private Discord interaction. The bot looks up that number in TVM's approved roster, sends a one-time code to the **email recorded in the roster**, and grants only the configured `TVM Member` role after the code is confirmed. TVM membership, not possession of any McGill email address, determines eligibility.

The initial sender will use a subdomain the current operator controls, such as `tvm.dextery.dev` **if DNS access to that domain is available**. TVM DNS access is not required for the first release. Resend requires a verified domain for normal sending; its test sender is not a production substitute. A future move to a TVM-owned sender should require only mail configuration and DNS changes, not a new verification flow. [Resend verified domains](https://resend.com/docs/dashboard/domains/introduction)

## Starting point and prerequisites

This repository has no application code yet. The first implementation step is to import or fork EmailVerify at a pinned upstream commit, retain its AGPL license, and record the commit and local changes. Publish the complete corresponding source for the running modified bot, as required by the [upstream license notice](https://github.com/lkaesberg/EmailVerify#license). Do not commit credentials or the real membership roster.

Collect these inputs before production configuration:

| Input | Needed for |
| --- | --- |
| TVM roster with `Student ID` and `Email` columns | Eligibility and delivery address |
| Eligibility policy | Which roster rows are active; whether workshop/training fields matter |
| Discord application token and application ID | Dedicated verification bot |
| Discord server ID and `TVM Member` role ID | Restrict bot and role assignment to TVM |
| Coolify project/server access | Deployment and persistent storage |
| Resend account and DNS access to an operator-controlled domain | Verified sending subdomain and SMTP key |
| Designated TVM administrators | Roster replacement, account transfers, and incident response |

Treat the pasted mention of `Member List F26 - Master.csv` as a description of the expected format; the file is not in this repository. Keep the live CSV in protected storage outside Git. Decide who is authorized to provide and update it before importing it.

## Implementation steps

### 1. Establish the base application

- Pin an EmailVerify revision and inspect its current verification, CSV, persistence, configuration, and role-granting paths before changing them. Preserve upstream notices and license.
- Add a project README with the upstream commit, build/start instructions, configuration reference, and a link to the published source of the deployed version.
- Add `.gitignore` and example configuration files that exclude `.env.local`, tokens, database files, backups, and real CSV files. Keep examples synthetic.
- Run the upstream bot locally with a test Discord application and synthetic roster to establish a working baseline.

**Done when:** A clean checkout can build and start from documented, secret-free configuration.

### 2. Make the roster the sole eligibility source

- Replace the member-facing email entry with a private student-number entry. Look up the destination email from the roster; never let a member override it.
- Parse CSV by header name using a CSV parser. Preserve student numbers as strings, including leading zeroes. Normalize only according to an explicit policy; do not silently rewrite identifiers.
- Validate the entire import before activation: required headers and fields, usable email addresses, duplicate student numbers, and conflicting email mappings. Reject an invalid replacement without modifying the active roster.
- Store an active roster version and make replacement an administrator-only operation. A missing, empty, or unreadable active roster closes verification and alerts administrators.
- Remove or disable any domain-based or alternate email-list route that could grant `TVM Member` without an active roster match. Do not add a broad `mcgill.ca` or `mail.mcgill.ca` allow rule.
- On roster replacement, revoke `TVM Member` from users who are no longer eligible, invalidate their pending codes, and record the result for administrator review. Define how a corrected student number or email is handled without silently transferring an existing claim.

**Done when:** An eligible student number sends to exactly the roster address; an absent number, malformed roster, or broad-domain address cannot produce a role grant.

### 3. Complete the verification and account-binding flow

1. Member clicks the verification button in `#verify` and privately submits a student number.
2. Bot checks the active roster and its sending limits. Responses should not reveal whether a particular student number exists or display the full roster email.
3. Bot creates a short-lived code tied to the Discord user, server, student number, and roster version, then emails the recorded address.
4. On code submission, bot enforces expiry and attempt limits, rechecks current roster eligibility and account binding, and consumes the code once.
5. Bot grants only `TVM Member` and records the claim. If role assignment fails, it reports failure and alerts administrators rather than claiming success.

Keep the upstream expiry, attempt limit, and resend cooldown unless inspection reveals a reason to change them. Add limits per Discord account, per student number, and across the server to prevent enumeration and protect sending capacity. Persist pending state across restarts. Allow one Discord account per roster member; make transfers an administrator-only action with an audit trail. Do not expose student numbers, full emails, or codes in routine Discord messages and logs. Review retention and deletion behavior for roster and verification data.

**Done when:** Wrong, expired, reused, transferred, or revoked claims cannot grant a role, including after a bot restart.

### 4. Configure Resend and Discord

- Verify an operator-controlled sending subdomain in Resend using the DNS records Resend provides. Preserve existing inbox records. Use a sender such as `TVM Verification <verify@tvm.dextery.dev>` only after that subdomain is verified. A mailbox at the sender address is optional for outbound-only sending. [Resend domain guide](https://resend.com/docs/dashboard/domains/introduction)
- Create a dedicated Resend API key. Configure EmailVerify for `smtp.resend.com`, username `resend`, API key as password, port `465`, and implicit TLS. Supply these through Coolify secrets; do not print them in logs. [Resend SMTP settings](https://resend.com/docs/send-with-smtp)
- Create a dedicated Discord application; enable the member intent required by the selected upstream revision. Install with bot and application-command scopes and the permissions actually needed. Place the bot role above `TVM Member`. [EmailVerify setup](https://github.com/lkaesberg/EmailVerify#discord-developer-portal-setup)
- Create a `#verify` channel visible to unverified members. Restrict member channels to `TVM Member`; test with a normal user account because administrator permissions can bypass channel restrictions. Restrict roster operations, manual verification, and account transfers to designated administrators.

**Done when:** A test message reaches a real target inbox, the bot can grant and remove `TVM Member`, and an unverified account cannot access member channels.

### 5. Deploy in Coolify

- Build the pinned fork from this repository. Run one bot replica initially, with automatic restart and outbound access to Discord and Resend SMTP.
- Supply secrets as Coolify environment variables. Add environment-variable support in the fork if the upstream configuration requires a file. Never place live credentials or the roster in a Compose file or source-controlled config.
- Persist the application's actual database and active roster paths with a Coolify mount declared in Compose or configured on the application. Confirm the paths against the pinned source before deployment; the pasted proposal's `/usr/app/config/bot.db` is a path to verify, not an assumption. Keep administrative or statistics endpoints private.
- Back up database and roster data to a location outside the deployment server and test a restore. A persistent mount survives normal container replacement but is not a backup. [Coolify persistent storage](https://coolify.io/docs/core/persistent-storage/storage-mounts/overview)

**Done when:** Restart and redeploy preserve roster, claims, and pending verification; a tested backup restores them.

### 6. Validate, pilot, and hand over

Use a private Discord test server and synthetic roster first. Then test with a small group of real TVM administrators before opening `#verify` to members.

| Scenario | Expected result |
| --- | --- |
| Eligible student number and correct code | `TVM Member` granted once |
| Unknown number or wrong destination attempt | No code to an arbitrary address; private generic response |
| Wrong, expired, or reused code | Rejected within attempt limits |
| Member removed while code is pending | Code rejected; role not granted |
| Existing member removed by roster replacement | Role revoked and claim reviewed |
| Same roster member claimed by a second Discord account | Administrator transfer required |
| Invalid or empty replacement CSV | Existing valid roster remains active; verification closes if no valid roster exists |
| SMTP outage or Discord permission failure | No false success; administrator notified |
| Restart, redeploy, and restore | Roster and verification state remain consistent |

Check inbox and junk placement as well as Resend's delivery record. Before rollout, check the account's current sending allowance and budget for tests, resends, and a staged launch; service limits can change. Write a short administrator runbook covering roster replacement and revocation, account transfers, backups/restores, key rotation, sender-domain migration, and how future TVM admins obtain access to Coolify, Resend, Discord, and the source repository.

## Release gate

Open verification to members only after the roster policy and candidate CSV are approved, the complete flow and revocation tests pass, the sender domain is verified, storage and restore are tested, the deployed source link is publicly accessible, and at least two designated administrators can perform the documented handover tasks.
