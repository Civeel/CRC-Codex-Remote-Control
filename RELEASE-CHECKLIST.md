# Release verification

- Distribution: CRC: Codex Remote Control 0.2.0, prepared on 2026-10-09.
- Current rollback included: resumable mobile approvals without automatic desktop popups.
- Independent npm ci --ignore-scripts installation completed in the isolated staging copy.
- All 29 tests passed on Windows with Node.js 24.16.0, including real Hook/server integration using generated credentials, random ports and synthetic Codex profiles.
- Setup and Hook installation/uninstallation tests only used temporary synthetic directories. No real Hook installation, Tailscale changes or active-service restart performed during synchronization.
- Explicit source allowlist excludes runtime secrets, logs, databases, backups, generated vendor documents and private diagnostic artifacts.
- Source files scanned for the known local panel tokens/API key, personal profile/project paths, device/tailnet identifiers, conversation/environment IDs and non-example email addresses: zero matches. This is a packaging check, not a security certification.
- No .env, node_modules, runtime data or automatic desktop-popup implementation included in the upload distribution.
- SHA256SUMS covers all other distribution files; the synchronization manifest verifies the final copy.
- GitHub Windows Node.js 22/24 CI is configured but has not run on GitHub before upload.
- Quota/provider tests use mocked endpoints; actual quota access and desktop compatibility depend on the receiving user's Codex/provider environment.
- npm audit was not rerun for this update; no new runtime dependencies were added.

After running setup or the app, review exclusions before uploading additional files. See docs/PUBLISHING.md.
