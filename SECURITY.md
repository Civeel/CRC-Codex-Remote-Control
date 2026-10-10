# Security and privacy

CRC controls real Codex authorization decisions. Keep access confined to trusted devices and users.

## Security boundary

- The HTTP service binds to `127.0.0.1`; Tailscale Serve provides private HTTPS. Tailnet membership and ACLs are the network boundary. CRC does not implement a hardware-backed device whitelist.
- The panel access token permits reading conversation metadata and events and deciding active permission requests. Treat it as a password.
- The independent Hook token authenticates local Hook event submission. Do not enter it on the phone or expose it to others.
- Panel sessions use HttpOnly, SameSite=Strict cookies and expire after eight hours. Cookies are marked Secure when the proxy indicates HTTPS.
- Every active request can be manually allowed, including unknown command scopes. Scope detection does not restrict authorization. Review tool parameters before deciding.
- Away mode reserves mobile routing for 24 hours from the last active heartbeat, including new requests during phone disconnection. It grants no permission automatically. Mobile sessions are authenticated and retain their 8-hour expiry; reauthentication clears the prior session reservation. Service restart clears reservations. With away mode disabled, new requests use native Codex approval or questions when mobile CRC is offline. Requests already received while online remain pending after disconnection and resume after reconnection. No permission is granted automatically. Expired, already-decided, interrupted and non-Hook requests are rejected. Service failure returns control to native Codex approval.
- Question answers are transient server memory, never stored in CRC events; submitted answers still enter Codex context. Browser drafts are in memory only.
- Balance lookup uses read-only endpoints. Black AI Coding credentials are read only for the verified configured HTTPS origin; redirects are forbidden, and keys/raw responses never go to the phone. Only the allowlisted balance fields are returned.
- Current-task monitoring reads local Codex records and databases, filters error details, and does not restart or take over desktop tasks.
- CRC grants per-call Codex permission only. It does not override Windows UAC, ACLs, Codex trust, organizational policies or confirmations outside the supported Hook.

## Local storage

`.env`, `data/events.ndjson` and Codex Hook backups may contain secrets, prompts, paths, commands, filenames and device metadata. Runtime event storage is local and is not encrypted by CRC. Protect it with your operating system account, file permissions and disk encryption. The default `.gitignore` excludes runtime data; custom data directories need equivalent exclusions.

Do not post real logs, `.env`, pairing codes, tokens, conversation IDs, screenshots or diagnostic reports without manually reviewing and removing private content. The included tests use synthetic data and temporary credentials.

The project makes no claim of complete audit logging. Hooks describe observed events rather than the full model conversation, and a client cannot prove successful execution merely from an approval response.

## Credential changes

If a token is exposed, stop the service, replace both tokens with independent random values in `.env`, then restart the service and reconnect clients. Restarting invalidates all server-side sessions. Update any environment variables that override `.env` as well. Do not store secrets in Git history.

## Reporting a vulnerability

Do not file a public issue containing an exploit, credentials or private logs. Use the repository's GitHub **Security → Report a vulnerability** when private reporting has been enabled by its maintainer. If it is unavailable, ask for a private reporting channel without disclosing details publicly.

Version 0.1.x receives best-effort fixes. No response-time or compatibility guarantee is provided.
