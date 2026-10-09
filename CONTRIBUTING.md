# Contributing to CRC

1. Fork the repository and create a branch for a focused change.
2. Run `npm ci` and `npm test` with Node.js 22 or newer.
3. For changes to mobile authorization, verify allow, deny, desktop handoff, offline behavior, stale requests and independent conversations.
4. For UI changes, check narrow phone widths, long titles and commands, disconnect/reconnect behavior, and readable authorization details.
5. Update documentation for user-visible changes and submit a pull request explaining what changed and how it was verified.

Do not commit runtime files, real credentials, personal domains, local profiles or conversation data. Use synthetic fixtures. Do not add automatic approvals or weaken authentication as part of unrelated changes. Security-sensitive changes should state the intended permission model clearly.

The first release targets Windows. Changes for other systems require appropriate testing and accurate support documentation.

Contributions are licensed under the project's MIT license.
