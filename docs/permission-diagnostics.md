# Expanded permission diagnostics investigation

Status: proposed follow-up, not implemented or deployed. No production permissions were inspected or changed during this investigation.

## Current coverage and gaps

`scripts/check-discord.js` checks the bot token/application, member intent, role existence/hierarchy, bot access to the alert channel and shoot resources, and alert-channel privacy. `src/shared/channelPermissions.js` already models the server baseline, @everyone overwrite, aggregated role overwrites, member overwrite, and owner/Administrator bypass. Existing alert-privacy and production-access tests cover important combinations.

It does not check human access to ordinary member channels, Broadcast/Post Credits, or each shoot/archived channel. A passing result therefore cannot establish that an Admin Team member without GM can see member channels, that outsiders cannot see production chats, or that archived participants cannot post. Those policies are currently documented/manual checks. Categories alone are insufficient: independently configured children can differ.

## Recommended first increment

Add an opt-in, read-only CLI mode to `discord:check`, not an automatic permission repair or a public command. Keep existing checks as the default. Use an explicit policy manifest with channel/category IDs and intended access; do not infer policies from channel names or assume every private channel belongs to the bot. Do not add startup failures for policies whose coverage has not been approved.

Evaluate these synthetic role profiles against each selected channel's actual overwrites:

| Profile                        | Member channels          | Shoot invitation                | Another shoot       | Joined active shoot  | Joined archive                    |
| ------------------------------ | ------------------------ | ------------------------------- | ------------------- | -------------------- | --------------------------------- |
| Roleless / Unverified          | Hidden                   | Hidden unless explicitly public | Hidden              | No participant grant | No participant grant              |
| GM / Exec                      | View as configured       | View, history, add reaction     | Hidden              | View, history, post  | View, history, no posting/threads |
| Admin Team without GM          | View as configured       | View, history, add reaction     | Hidden              | View, history, post  | View, history, post               |
| Admin Team + production access | View as configured       | View as configured              | View, history, post | View, history, post  | View, history, post               |
| Production access only         | Explicit policy required | Not automatically eligible      | View, history, post | Role-based access    | Role-based posting                |

Also test GM+Admin, ordinary roles with conflicting overwrites, the organizer exception, direct participant overwrites, and a participant whose membership/production role was removed. Server ownership and Discord Administrator always bypass overwrites; report this as a bypass, not evidence that ordinary access is configured correctly. Production access does not grant bot-management authority or membership eligibility.

For shoots, derive expected grants from the shoot policy and participant state through a read-only repository interface. Compare effective permissions and unexpected overwrites, without synchronizing or creating resources. Do not open a live `Store` merely to inspect it: its constructor runs migrations. Use an explicitly read-only connection or an operator-created backup.

## Correctness and privacy requirements

- Reuse the permission calculator, but expose effective permission bits and explanations rather than only a boolean. Require View Channel for effective reading/posting; account for Send Messages dependencies and thread-specific permissions.
- Inspect every selected child, including independently configured children. Report coverage counts and exclusions, not an unqualified server-wide pass.
- Distinguish a missing member/channel (404) from an inaccessible resource (403), rate limit, or network failure. Unknown/incomplete data is **indeterminate**, never a passing privacy check. The current CLI's `get()` collapses non-2xx bodies to null; expanded diagnostics need explicit status handling and bounded retries.
- Synthetic profiles prove only those role combinations. An optional named-account audit must fetch fresh roles and apply personal overwrites; it must not claim to cover every server member. Avoid broad member enumeration by default.
- Use bounded concurrency, respect Discord retry timing, and fetch roles/channels once per run. Never log tokens, emails, request bodies, or rosters. Keep account-specific reports private; files containing private channel/account information should be mode 0600 and outside Git.
- No writes, role assignment, database migrations, messages, command registration, or automatic repair. A suggested repair must identify the exact differing overwrite and preserve unrelated permissions; applying it requires separate authorization.

## Acceptance tests before enabling

Use synthetic Discord responses, without credentials: role/member overwrite precedence; owner/Administrator bypass; Admin Team without GM; production access separate from management; archived read-only participants; departed/ineligible participants; synchronized versus independent children; permission dependencies; 403/404/429/network errors; incomplete coverage; redaction; and an adapter that rejects every non-GET request. Then run controlled test-server checks with representative human accounts before any production read-only audit.
