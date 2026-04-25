# Release signing keys

This directory holds the keys used to sign release artifacts. Two private keys live here and **must never be committed** (covered by `.gitignore`).

## Files

| File | Type | Purpose | In git? |
|---|---|---|---|
| `kibrary-updater.key` | Tauri minisign Ed25519 private | Signs `latest.json` updater bundles so existing installs accept the upgrade | **NO** (gitignored) |
| `kibrary-updater.key.pub` | Tauri minisign Ed25519 public | Pasted verbatim into `tauri.conf.json` → `plugins.updater.pubkey`. Public — fine to share. | YES |
| `appimage-signing-private.asc` | GPG/OpenPGP ed25519 private | Signs `*.AppImage` (and optionally `.deb`/`.rpm`) so users with the public key can verify integrity | **NO** (gitignored) |
| `appimage-signing-public.asc` | GPG/OpenPGP ed25519 public | Distributed to users so they can `gpg --verify` an AppImage signature. Public — fine to share. | YES |

## Identity used

Both keys were generated with:
- Name: `Kibrary Release Signing`
- Email: `raphaelcasimir.inge@gmail.com`
- GPG fingerprint: `ED37847C4ED3376CA28546538E0FDC9F2E542C63`
- GPG key ID: `8E0FDC9F2E542C63`
- GPG expiry: 2 years (2028-04)
- **No passphrase** on either key (auto-generated for unattended CI signing).
  If you want a passphrased key, regenerate by hand and update `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` accordingly.

## What you must do before tagging a release

### 1. Add private keys to GitHub repo secrets
In `https://github.com/jazari-akuna/kibrary-automator/settings/secrets/actions`, add:

| Secret name | Value source |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Whole contents of `kibrary-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty string (the key has no passphrase) |
| `GPG_PRIVATE_KEY` | Whole contents of `appimage-signing-private.asc` |
| `GPG_PASSPHRASE` | Empty string (no passphrase) |

To paste the contents safely, use `cat keys/<file>` in a local terminal and copy the full text into the GitHub UI.

### 2. (Optional) Apply to SignPath Foundation for Windows signing
Free for OSS — see `docs/SIGNING.md`. Until approved, Windows users will see a SmartScreen warning saying "Unknown publisher".

### 3. macOS — nothing to do
We use ad-hoc signing (`signingIdentity: "-"` in `tauri.conf.json`). Users right-click → Open the first time. See `docs/SIGNING.md`.

## Local build with these keys

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat keys/kibrary-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
PATH="$HOME/.cargo/bin:$PATH" \
pnpm tauri build
```

Output: `src-tauri/target/release/bundle/{deb,rpm,appimage}/Kibrary_*.{deb,rpm,AppImage}` plus `.sig` files for each (used by the in-app updater).

To GPG-sign the AppImage afterwards:

```bash
gpg --batch --yes --pinentry-mode loopback --detach-sign --armor \
    --local-user raphaelcasimir.inge@gmail.com \
    --output <appimage>.asc \
    <appimage>
```

The `.asc` file is what users verify with `gpg --verify <appimage>.asc <appimage>`.

## Key rotation

If a key is ever compromised:

1. Revoke it (`gpg --gen-revoke <fingerprint>` for GPG; for Tauri just regenerate)
2. Generate a fresh keypair
3. Replace the public key in `tauri.conf.json` (Tauri) or distribute the new GPG pubkey
4. Update GitHub secrets
5. **Existing users of the auto-update flow will need to manually re-install** because their installed app's bundled pubkey no longer matches. This is by design and limits the blast radius.
