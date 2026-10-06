# Contributing

This project supports TVM’s Discord operations. Open an issue describing the problem and expected behavior before proposing substantial workflow changes. Small fixes can go directly to a pull request.

Use Node.js 22.13+ and `npm ci`. Run `npm run check` before submitting. Add regression tests for behavioral fixes using temporary databases and Discord/mail adapters; tests must not require live credentials. For container changes, also run the smoke checks in [the development guide](docs/development.md).

Describe the trigger, resulting behavior, and validation in your pull request. Keep changes focused. Preserve authoritative snapshot uploads, inactive account links, existing role ownership, private shoot permissions, and Toronto scheduling unless the change explicitly addresses those policies.

Append new numbered migrations rather than editing applied ones. Update operator documentation when configuration or user workflows change. Keep secrets, member rosters, and database files out of commits and issue attachments.

Contributions remain under AGPL-3.0-or-later. Retain existing copyright notices and attribution.
