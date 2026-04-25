# Kibrary v0.2.0 — first public release

Kibrary turns JLCPCB part numbers into committed KiCad libraries. Paste a list of LCSC codes, watch them download in parallel, review/edit each before commit, and have everything land in your library repo as one git commit per part — automatically registered with your KiCad install.

This first release combines what the dev plans called P1 (MVP), P2 (Library Management), and P3 (polish + packaging) into one shipping artifact.

## Highlights

- **Add room** — paste a BOM or LCSC list, parallel download, three review modes (sequential, pick, bulk-assign), in-app property editor with debounced autosave, real KiCad editor handoff with file-watcher refresh.
- **Libraries room** — browse, rename, move, delete already-committed components; library metadata editor; per-component footprint thumbnails rendered with `kicad-cli`.
- **One commit per part** — auto-commits to git on every save, with a 30-second Undo toast.
- **Optional `search.raph.io` integration** — thumbnail-driven part search, one-click +Add to queue. API key stored in the OS keychain, not in plain config.
- **Self-contained installers** — Python sidecar bundled via PyInstaller; users don't need Python on their machine.
- **Auto-update** via GitHub Releases (`tauri-plugin-updater`).
- **Light + dark themes**.

## Install

| Platform | Download | First-launch note |
|---|---|---|
| Linux x86_64 (AppImage) | `Kibrary_0.2.0_amd64.AppImage` | `chmod +x` then double-click. GPG signature `.asc` next to it for `gpg --verify`. |
| Linux x86_64 (.deb)     | `Kibrary_0.2.0_amd64.deb`     | `sudo apt install ./Kibrary_0.2.0_amd64.deb` |
| Linux x86_64 (.rpm)     | `Kibrary-0.2.0-1.x86_64.rpm`  | `sudo rpm -i Kibrary-0.2.0-1.x86_64.rpm` |
| Linux Flatpak           | (build from `flatpak/`)        | See `docs/SIGNING.md`. Flathub submission planned. |
| macOS                   | `Kibrary_0.2.0_aarch64.dmg` (or `_x64.dmg`) | **Right-click → Open** the first time (we use ad-hoc signing, not Apple Developer). The OS remembers the approval. |
| Windows                 | `Kibrary_0.2.0_x64-setup.nsis.exe` | SmartScreen may say "Unknown publisher" — click "More info → Run anyway". (Signed builds via SignPath Foundation pending.) |

After the first launch, the auto-updater takes over.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Kibrary.app — single binary per OS                       │
│   Frontend (SolidJS + Tailwind, 22 blocks)                 │
│         │   tauri.invoke()                                 │
│   Rust core (Tauri 2)                                      │
│         │   JSON-RPC over stdin/stdout                     │
│   Python sidecar — 41 RPC endpoints                        │
│      kiutils, JLC2KiCadLib, GitPython, httpx, keyring,    │
│      kicad-cli, notify watcher                             │
└────────────────────────────────────────────────────────────┘
```

## Verifying signatures

Each release artifact is signed two ways:

1. **`tauri-plugin-updater` minisign signature** (`<artifact>.sig`) — used automatically by the in-app updater. The public key lives in `tauri.conf.json` and ships with every install.
2. **GPG signature on the AppImage** (`Kibrary_0.2.0_amd64.AppImage.asc`) — verify with:
   ```bash
   curl -O https://github.com/jazari-akuna/kibrary-automator/releases/download/v0.2.0/Kibrary_0.2.0_amd64.AppImage{,.asc}
   gpg --import keys/appimage-signing-public.asc   # one-time
   gpg --verify Kibrary_0.2.0_amd64.AppImage.asc Kibrary_0.2.0_amd64.AppImage
   ```
   Public key fingerprint: `ED37847C4ED3376CA28546538E0FDC9F2E542C63`.

## Acknowledgments

- [Tauri](https://tauri.app/) for the desktop framework
- [SolidJS](https://www.solidjs.com/) for the reactive UI
- [JLC2KiCadLib](https://github.com/TousstNicolas/JLC2KiCadLib) for the JLCPCB → KiCad conversion
- [kiutils](https://github.com/mvnmgrx/kiutils) for KiCad-format parsing
- [kicanvas](https://kicanvas.org/) for in-app symbol/footprint rendering
- [search.the-chipyard.com](https://search.the-chipyard.com) (`jlc-search`) for the parts search backend

## Changelog

See [`CHANGELOG.md`](../CHANGELOG.md) for the full feature list and per-area details.
