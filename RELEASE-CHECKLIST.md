# Release verification

- CRC 0.3.0, prepared 2026-10-10.
- Away mode, reconnect snapshots and native fallback states included.
- All 30 tests passed in the isolated staging copy on Windows Node.js 24.16.0, using generated credentials, random ports and synthetic profiles. Existing dependencies from the prior independent npm ci installation were reused; no runtime dependency changed.
- Source allowlist excludes credentials, runtime data, local diagnostics and backups.
- Privacy and SHA256 checks run before synchronization.
- GitHub Windows Node.js 22/24 CI must pass before the release is published.
- No new runtime dependencies.
