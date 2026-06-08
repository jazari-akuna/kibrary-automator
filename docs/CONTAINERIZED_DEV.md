# Containerized development

You don't need Rust, Node, KiCad, or WebKitWebDriver on the host. Everything
builds and runs inside the dev container defined by `Dockerfile.dev` +
`docker-compose.dev.yml`.

## Why builds felt slow (and why they won't anymore)

The app's own Rust shell is small (~1.7k lines). What's expensive is the
**Tauri/WebKit runtime and its few hundred transitive crates**, compiled cold.
The dev compose used to cache only the *downloaded* crate sources, so every
build recompiled all of them from scratch — that's the "~1 hour."

`docker-compose.dev.yml` now also persists the **compiled `target/` dir** (plus
cargo-git and a container-native `node_modules`) in named volumes. So:

- **First Rust build in the container:** slow once (compiles the dep tree).
- **Every build after:** incremental — seconds for a shell change.
- **Frontend or Python change:** **no Rust compile at all.** That's ~90% of the
  work — `vite` rebuilds in ms, the Python sidecar needs no build step.

## One-time setup

```bash
docker compose -f docker-compose.dev.yml build dev      # build the dev image (once)
docker compose -f docker-compose.dev.yml run --rm dev bash
# inside the container:
pnpm install                                            # populates the node-modules volume (once)
```

## Daily loop (inside the container)

| You changed | Command | Cost |
|---|---|---|
| Frontend (`src/**`) | `pnpm test` / `pnpm build` / `pnpm dev` | seconds |
| Python sidecar (`sidecar/**`) | `pytest sidecar/tests` | seconds |
| Rust shell (`src-tauri/**`) | `cd src-tauri && cargo build` | first build slow, then incremental |
| Full app (GUI) | `pnpm tauri dev` | reuses the cached `target/` |

## Real-build / GUI verification

The 3D-viewer visual-verify harness needs the bundled app:

```bash
# inside the container, with the target cache warm:
pnpm tauri build                                        # produces the .deb
VISUAL_VERIFY_IMAGE=kibrary-visual-verify bash scripts/visual-verify.sh
```

The first `tauri build` pays the one-time compile; subsequent ones are fast
because `target/` persists in the `cargo-target` volume.

## Optional: faster *cold* builds (CI / fresh checkouts)

Add [`sccache`](https://github.com/mozilla/sccache) and set
`RUSTC_WRAPPER=sccache` to share a compilation cache across clean builds. Not
needed for the local incremental loop above, but it helps CI.
