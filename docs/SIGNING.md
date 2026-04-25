# Code Signing & Distribution

Reference for the per-platform signing setup. Tasks P18-P21 (in `docs/superpowers/plans/2026-04-26-p2-extras.md`) implement these.

## Recommended setup (one-liner per platform)

- **macOS**: **Ad-hoc signing** (`signingIdentity: "-"`). Free, no Apple Developer Program. End users must right-click → Open the first time (one-time per machine). Documented in the install instructions; no maintainer cost. We will NOT publish to the Mac App Store.
- **Windows**: SignPath Foundation (free for OSS) — application/approval required, manual per-release approval, OV-equivalent SmartScreen behavior. Fallback: Azure Trusted Signing (~$120/yr) if SignPath approval is too slow.
- **Linux**: AppImage + .deb + .rpm direct to GitHub Releases via `cargo tauri build`. GPG-sign the AppImage with `SIGN=1`. No further infra; add Flathub later if user demand warrants.
- **Auto-update**: `tauri-plugin-updater` with `createUpdaterArtifacts: true` + `tauri-apps/tauri-action@v0` (`includeUpdaterJson: true`) pointing at `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.

---

## macOS — ad-hoc signing (free, chosen path)

**Decision:** Kibrary uses ad-hoc signing (`signingIdentity: "-"`). The trade-off: end users see a "cannot be opened because Apple cannot check it for malicious software" warning on first launch and must right-click → Open once. After that, the OS remembers the approval and the app launches normally. No annual fee, no Mac App Store, no Apple Developer Program.

### tauri.conf.json
```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "-",
      "minimumSystemVersion": "10.15"
    }
  }
}
```

No CI secrets required for macOS.

### User-facing first-launch instructions (put in README + release notes)

```markdown
**macOS first-launch:** Because Kibrary isn't notarized by Apple,
the first time you open it macOS will say "Kibrary cannot be opened
because Apple cannot check it for malicious software." Workaround:
right-click (or Control-click) the Kibrary app and choose **Open**
from the context menu. Confirm "Open" in the dialog. The OS remembers
this approval and future launches work normally.

If macOS instead says "Kibrary is damaged and can't be opened" (rare,
sometimes happens after AirDrop or browser quarantine), open Terminal
and run:
    xattr -d com.apple.quarantine /Applications/Kibrary.app
Then double-click Kibrary normally.
```

### If you ever change your mind and DO want Apple notarization
The full path costs $99/yr (Apple Developer Program) plus the cert/notarization setup. See [Tauri's macOS signing docs](https://v2.tauri.app/distribute/sign/macos/) for the env vars. Not used by this project.

---

## Windows

### SignPath Foundation eligibility
- OSI-approved license, no commercial dual-licensing
- Active maintenance, existing releases
- Defined team roles with MFA on signing accounts
- Published "Code Signing Policy" page on the project website
- Manual approval per release (someone clicks approve in SignPath dashboard)

### tauri.conf.json (SignPath / Azure Trusted Signing)
```json
{
  "bundle": {
    "windows": {
      "signCommand": "trusted-signing-cli -e https://eus.codesigning.azure.net -a MyAccount -c MyProfile -d Kibrary %1"
    }
  }
}
```

For traditional PFX/thumbprint:
```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_SHA1_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.comodoca.com"
    }
  }
}
```

### Notes
- EV certificates **no longer grant instant SmartScreen reputation bypass** (Microsoft change in March 2024). EV is no longer worth the price premium for OSS.
- Self-signed certs are **worse than unsigned** — user sees red "Unknown publisher" warning with no obvious "Run anyway" button.

---

## Linux

### Tauri-bundled formats
`cargo tauri build` produces `.AppImage`, `.deb`, and `.rpm` automatically. Ship all three to GitHub Releases — covers ~95% of Linux users.

### GPG-signed AppImage (free, optional verification)
```
SIGN=1
SIGN_KEY=YOUR_KEY_ID
APPIMAGETOOL_SIGN_PASSPHRASE=...
APPIMAGETOOL_FORCE_SIGN=1
```
Caveat from Tauri docs: AppImage runtime does not validate signatures — users must `gpg --verify` manually. Convention more than enforcement.

### Optional: Flathub
Free, broad reach (GNOME/KDE), but requires offline-build manifest + manual review process. Not part of P2 scope; revisit if user demand warrants.

---

## Auto-update via `tauri-plugin-updater`

Tauri's updater uses an Ed25519 key pair distinct from platform code-signing certs.

### Generate keys
```bash
cargo tauri signer generate -w ~/.tauri/kibrary.key
# private key → CI secret TAURI_SIGNING_PRIVATE_KEY
# public key  → tauri.conf.json
```

### tauri.conf.json
```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "<paste public key>",
      "endpoints": [
        "https://github.com/<owner>/kibrary-automator/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }
    }
  }
}
```

### latest.json (auto-generated by tauri-action)
```json
{
  "version": "1.2.3",
  "notes": "...",
  "pub_date": "2025-04-25T10:00:00Z",
  "platforms": {
    "linux-x86_64":   { "signature": "...", "url": "..." },
    "darwin-aarch64": { "signature": "...", "url": "..." },
    "windows-x86_64": { "signature": "...", "url": "..." }
  }
}
```

### CI secrets
```
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD     # if key has a passphrase
APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD / APPLE_API_*
WINDOWS_CERTIFICATE / WINDOWS_CERTIFICATE_PASSWORD   # OR Azure / SignPath setup
```

### GitHub Actions workflow
Use `tauri-apps/tauri-action@v0` with `includeUpdaterJson: true`. The action assembles `latest.json` from all platform matrix outputs and uploads it to the GitHub Release.

`tauri-action v0.5.24+` uses `{os}-{arch}-{installer}` keys (e.g. `windows-x86_64-nsis`) when multiple installer types exist. Requires `tauri-plugin-updater >= 2.10.0`.

---

## Sources
- [macOS Code Signing | Tauri v2](https://v2.tauri.app/distribute/sign/macos/)
- [Windows Code Signing | Tauri v2](https://v2.tauri.app/distribute/sign/windows/)
- [Linux Code Signing | Tauri v2](https://v2.tauri.app/distribute/sign/linux/)
- [Updater Plugin | Tauri v2](https://v2.tauri.app/plugin/updater/)
- [GitHub Actions Pipeline | Tauri v2](https://v2.tauri.app/distribute/pipelines/github/)
- [SignPath Foundation — Open Source Community](https://signpath.io/solutions/open-source-community)
- [SmartScreen Reputation for Windows App Developers — Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
