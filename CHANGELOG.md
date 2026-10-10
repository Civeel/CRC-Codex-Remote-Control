# Changelog

## 0.3.0 — 2026-10-10

- Away mode retains new approval and question requests while the phone is locked, backgrounded or disconnected.
- Explicit 24-hour reservation, renewed by online heartbeats; native approval fallback remains available when away mode is disabled.
- Authoritative pending-request snapshots after stream reconnect, with answer drafts preserved.
- Explicit native approval/question task states instead of ambiguous inactivity messages.
- Waiting requests display a clear retained-request message.

## 0.2.0 — 2026-10-09

- Resumable approval and question requests across phone lock, backgrounding and disconnect.
- New requests use native Codex approval or questions when mobile CRC is offline; existing CRC requests remain recoverable after disconnection. No separate desktop popup is launched.
- Mobile option and text replies with strict per-question validation and one-time decisions.
- Failure/retry/uncertain task states, safe local record monitoring and honest progress animation.
- Read-only account quota and verified Black AI Coding balance display.
- Long-wait Hook installer, portable profiles and refreshed privacy-safe tests/documentation.

## 0.1.0 — Initial community release

- Private mobile access through Tailscale Serve.
- Codex Hook monitoring, project/conversation grouping and per-request mobile decisions.
- Offline handoff to native desktop approval and stale request protection.
- Per-conversation activity and explicit-plan progress.
- Portable configuration, random-token setup, merge-based Hook installation/uninstallation and diagnostics.
- Synthetic integration tests and Windows CI for Node.js 22/24.

Known limits: Windows is the initial target; desktop compatibility depends on Codex Hook and app-server availability. Conversation catalog queries have mock RPC coverage and require verification against the user's installed desktop version.
