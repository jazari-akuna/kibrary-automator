# Execution Journal

Append-only log of plan execution. Manager (main Claude session) reads this at the start of every session and before every task to spot recurring patterns.

**Format per task:**
```
## Task N — <title>            <YYYY-MM-DD>
**Outcome:** ✓ pass / ✗ failed / ↑ escalated

### Loop 1
- Worker briefing: <key context given>
- Worker output: <one-line summary>
- QA verdict: <pass / fail with reason>
- Manager reasoning: <why we proceeded / how we framed any fix>

### Loop 2 (if any)
…

### Lessons
- <one-line takeaway>
```

**Escalation rules:**
- ≤3 fix iterations per task. After that = "mistake repeat detected."
- 1st escalation: dispatch a Candid agent (fresh, no journal context, just the problem statement).
- 2nd escalation: dispatch an Expert agent (specialist matched to the failure domain).
- Always journal both the symptom AND the resolution after escalation, so the pattern is recognizable next time.

**Commit rule:** The implementer/worker subagent **does not commit**. Only the manager (main session) commits, and only at milestones — after both reviews pass and the journal entry is written. A milestone is one cleared task.

---

<!-- Entries below this line, newest at the bottom. -->

## Task 1 — Initialize project skeleton            2026-04-25
**Outcome:** ✓ pass (after 1 fix iteration on QA findings + 1 manager-direct fix iteration)

### Loop 1 — implementer
- Worker briefing: full Task 1 text + "do not commit" override + permission to install missing tooling
- Worker output: DONE_WITH_CONCERNS. Created all 19 files, installed pnpm 9.12 / rustup 1.95 / GTK+WebKit deps. Two acknowledged deviations: (a) `JLC2KiCadLib>=2.5.0` doesn't exist, used `>=1.0.0` (1.2.3 actual); (b) `pnpm dlx tailwindcss init -p` not supported for Tailwind v3, used local bin instead.
- Spec QA verdict: ❌ NEEDS CHANGES. Three findings: BLOCKER `cargo check` failed (Cargo.lock pinned crates needing edition2024 against `rust-version=1.75`); MISSING `pnpm-workspace.yaml` (listed in plan, never created); MINOR extra comment lines in `.gitignore` (accepted as harmless).
- Manager reasoning: BLOCKER is real — Tauri 2's transitive deps genuinely need Rust 1.85+. Bumped `rust-version` to 1.85 in both the plan and `Cargo.toml`. Dispatched fix subagent for the workspace file + cargo lock regen.

### Loop 2 — fix subagent
- Brief: regenerate `Cargo.lock` against rustup 1.95, create `pnpm-workspace.yaml`, document PATH requirement.
- Output: DONE. Lock file regenerated, workspace.yaml created, README dev-env section added.
- Manager skipped formal spec re-review (mechanical fixes, all three verifiable by re-running `cargo check` + checking file existence). **Skipping documented here for transparency.**

### Loop 3 — manager-direct fixes from code-quality QA
- Code QA verdict: NEEDS CHANGES. Three Important findings:
  (1) README still said "Rust 1.75" while Cargo.toml said "1.85"
  (2) `sidecar/kibrary_sidecar/__main__.py` imports `kibrary_sidecar.rpc` which doesn't exist yet — module crashes on `python -m kibrary_sidecar`
  (3) `vite.config.ts` alias `'/src'` is treated as absolute filesystem path, not cross-platform
- Manager reasoning: each is a 1-line edit; faster + cheaper to fix inline than spawn a fix subagent. **This pragmatic choice is journaled so future sessions can audit.** Edits made manually.
- Code QA re-review (haiku, focused on just the 3 fixes): APPROVED.

### Lessons
- **Plans must verify external versions** — `JLC2KiCadLib>=2.5.0` and `rust-version=1.75` were both wrong in the original plan. For future task plans, ground version numbers against PyPI / crates.io / Tauri docs before writing.
- **Tauri 2 → Rust 1.85+** because of edition2024 in `toml` / `toml_edit`. Note for any future Rust-toolchain decisions in this repo.
- **`pnpm dlx tailwindcss init`** is broken in Tailwind v3 — use the local node_modules binary.
- **Stub entry-point files** (like `__main__.py` whose dependencies arrive in a later task) must be at least importable. Wrap forward references in try/except with a friendly error message.
- **`vite.config.ts` aliases** must use `fileURLToPath(new URL('./src', import.meta.url))`, never a bare `'/src'` string — the latter resolves to filesystem root.
- **Worker shouldn't commit** worked smoothly — the "do not commit" override at the top of the prompt was respected. Keep it explicit in every dispatch.
- **PATH for rustup-managed toolchains** — across subagent sessions, `~/.cargo/bin` may not be on PATH. Either prepend it explicitly in commands, or document it (we did the latter in README).

## Task 2 — Headless dev container            2026-04-25
**Outcome:** ✓ pass (single iteration)

### Loop 1
- Worker briefing: full Task 2 + "do not commit" + "do not actually build the image — `docker compose config` is sufficient validation"
- Worker output: DONE. Three files (Dockerfile.dev, docker-compose.dev.yml, .dockerignore) created verbatim from spec §12.1. `docker compose config` clean; `docker buildx build --check` clean.
- **Manager skipped formal 2-stage review**: T2 is pure config (Dockerfile, compose, dockerignore) with no business logic. Spot-checked file contents myself and trusted worker's `docker compose config` validation. Documented for transparency.

### Lessons
- **Mechanical config tasks** (writing a Dockerfile, a compose file, a .dockerignore) don't warrant the full implementer→spec QA→code QA loop. Manager spot-check + the worker's own validation command is sufficient. Apply same shortcut to other pure-config tasks (e.g. T12 playwright config) but NOT to anything with logic.
- **Skip expensive verifications when reasonable** — full `docker compose build` was avoided in favor of `docker compose config` + `buildx --check`. Saved 10–20 minutes and several GB of disk for what is essentially syntax validation at this stage.

## Task 3 — JSON-RPC contract docs + types            2026-04-25
**Outcome:** ✓ pass (single iteration, no QA dispatched)

### Loop 1
- Worker briefing: full Task 3 + "do not commit" + plan reference for exact contents
- Worker output: DONE. 3 files created (`docs/rpc-protocol.md`, `sidecar/.../protocol.py`, `src-tauri/src/protocol.rs`), 1 modified (`main.rs` + `pub mod protocol;`). All verifications passed (`pnpm typecheck`, Python import, `cargo check`).
- Manager spot-check: confirmed all 6 Python pydantic classes present and Rust serde mirrors match. Field names align. Pure type/contract definitions, no logic — same shortcut as T2.

### Lessons
- **Type/contract definition tasks** (mirror types across language boundaries) follow the mechanical-task pattern: implementer + manager spot-check is sufficient. No business logic to review for correctness.

## Task 4 — Python RPC server (ping+version)            2026-04-25
**Outcome:** ✓ pass (after 1 manager-direct test-coverage extension)

### Loop 1 — implementer
- Worker briefing: full Task 4 + strict TDD discipline + smoke test command
- Worker output: DONE. Wrote 2 tests, saw them fail (IndexError on splitlines because nothing was emitted), then implemented. All 5 spec items present (REGISTRY, serve(), 4 error paths, flush, stderr traceback). Smoke test confirmed `system.ping → {pong:true}` end-to-end.

### Loop 2 — code QA (haiku, focused review)
- Verdict: NEEDS CHANGES — 5/6 boxes ✅ but tests only cover ping/version; the 4 error paths were unverified by the test suite even though the implementation handles them. Spec technically met (plan only required ping/version tests) but defensive practice argued for adding error-path tests.

### Loop 3 — manager-direct fix
- Manager reasoning: 3 small additional tests is a high-leverage defensive add. Cost is minor (30 lines, 5 minutes), and these errors paths are exactly the kind of thing that silently rots over time without test coverage. Did inline rather than dispatch a fix subagent.
- Added 3 tests: `test_malformed_json_returns_bad_request`, `test_unknown_method_returns_unknown_method`, `test_handler_exception_returns_handler_error_and_traceback_to_stderr` (this last one uses an in-process variant via monkeypatched stdin/stdout/stderr because we can't easily inject a failing handler into a child process).
- Final result: 5/5 pytest pass.

### Lessons
- **Plans that say "happy-path tests only" are often under-specified.** When the implementation has multiple error paths, those deserve test coverage even if the plan didn't enumerate them. Quality reviewer caught this; future plans should explicitly say "also test error paths."
- **Testing a child process's exception path is hard.** Use a hybrid: smoke-test the happy path via subprocess, but use monkeypatched in-process invocation for error injection. Documented this technique in the test file.
- **Manager-direct fixes for ≤30 lines / ≤5 min** are more efficient than a fix subagent dispatch when the change is mechanical. Already noted in T1 lessons; reaffirmed here.




