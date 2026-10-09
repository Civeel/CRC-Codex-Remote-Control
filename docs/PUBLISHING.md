# Publishing this source folder on GitHub

This source distribution contains templates rather than runtime credentials. Running setup or the app will create private files; check exclusions before publishing later changes.

1. Create a **public** GitHub repository, for example `CRC-Codex-Remote-Control`. The display name can be **CRC: Codex Remote Control**. GitHub repository names do not use a colon or spaces.
2. If uploading this folder, do not separately initialize GitHub's README or license; both are included.
3. Upload source files, including `.github`, `.gitignore`, `.gitattributes` and `.env.example`. Do not upload `.env`, `node_modules`, runtime `data` or local Hook backups.
4. In repository settings, enable Actions and private vulnerability reporting. Use the description: “Private mobile monitoring and per-request approvals for Codex Desktop through Tailscale.”
5. Verify the Windows Node.js 22/24 workflow passes after the push, then create a `v0.2.0` release. CI results must be checked on GitHub; the local verification does not prove they have run.

Optional Git upload from this folder:

```powershell
git init
git branch -M main
git add .
git status
git diff --cached --stat
# Review all staged files for secrets before committing.
git commit -m "Update CRC to 0.2.0"
# Replace the URL with your actual GitHub repository URL.
git remote add origin https://github.com/YOUR-ACCOUNT/CRC-Codex-Remote-Control.git
git push -u origin main
```

The placeholder account is not a real maintainer address. Configure your own Git author identity; this distribution embeds no personal author name or email. `npm` package publication is intentionally disabled by `private: true`; this is a GitHub source project.
