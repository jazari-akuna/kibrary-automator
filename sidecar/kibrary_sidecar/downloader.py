"""
Parallel download orchestrator for LCSC part assets.

ASYNC_REGISTRY is defined here (not in methods.py, per Task 16 constraints).
rpc.py imports:
  - REGISTRY        from kibrary_sidecar.methods   (sync handlers)
  - ASYNC_REGISTRY  from kibrary_sidecar.downloader (async handlers)

Per-part progress events
------------------------
For each part the orchestrator emits at minimum:
  - status='downloading', progress=0      (work has been dispatched)
  - status='downloading', progress=10     (JLC2KiCadLib started)
  - status='downloading', progress=70     (assets fetched, post-processing)
  - status='ready'|'failed', progress=100 (terminal)

Frontend uses these to drive both the per-row progress bar and the
"Downloading… (N of M)" button label.
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Awaitable, Callable

from kibrary_sidecar import jlc
from kibrary_sidecar import icons
from kibrary_sidecar import staging as staging_mod  # `staging` param shadows the module
from kibrary_sidecar.event_names import DOWNLOAD_DONE, DOWNLOAD_PROGRESS


# ---------------------------------------------------------------------------
# Lazy accessor for search_client.
#
# ``search_client`` builds a module-scoped ``httpx.Client`` at import time, and
# importing it here at module top dragged ``httpx`` (TLS/SSL machinery) onto
# the sidecar's first-RPC critical path: the startup chain is
# ``__main__`` -> ``rpc`` -> ``downloader``, so a top-level
# ``from kibrary_sidecar import search_client`` loaded httpx the moment the
# sidecar started. The only place that actually needs search_client is the
# per-part metadata fetch inside ``run_batch``'s worker, well after startup, so
# we defer the import to there. Mirrors the lazy accessor pattern in
# ``methods.py`` (``_search_client`` / ``_lib_scanner`` / ...).
# ---------------------------------------------------------------------------
def _search_client():
    from kibrary_sidecar import search_client
    return search_client


def _missing_assets(assets: dict) -> list[str]:
    """Return human-readable names of assets the downloader expected but
    didn't find. Used to derive partial-failure warnings (e.g. symbol
    committed but no footprint)."""
    missing = []
    if not assets.get("symbol"):
        missing.append("symbol")
    if not assets.get("footprint"):
        missing.append("footprint")
    if not assets.get("model_3d"):
        missing.append("3D model")
    return missing

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-part download retry with backoff (CLI parity).
#
# The legacy CLI retried a failed part download 3 times with a 2s backoff so a
# transient JLC2KiCadLib/network blip didn't fail the part outright (forcing
# the user to click Retry). The current orchestrator dropped that behaviour;
# we restore it here, bounded so we never retry forever.
#
# Defaults are module constants (CLI parity: 3 attempts / 2s) overridable via
# env vars for the rare stress-test / slow-network case, and per-call via the
# ``run_batch`` keyword args. Kept as simple constants rather than a
# settings.json schema change so the hot download path doesn't read settings.
# ---------------------------------------------------------------------------
DEFAULT_MAX_ATTEMPTS = int(os.environ.get("KIBRARY_DOWNLOAD_MAX_ATTEMPTS", "3"))
DEFAULT_RETRY_BACKOFF = float(os.environ.get("KIBRARY_DOWNLOAD_RETRY_BACKOFF", "2.0"))

EmitFn = Callable[[dict], Awaitable[None]]
# A download function may optionally accept a progress callback (int 0-100).
DlFn = Callable[..., Awaitable[tuple[bool, str | None]]]


async def _default_dl(
    lcsc: str,
    target: Path,
    progress: Callable[[int], None] | None = None,
) -> tuple[bool, str | None]:
    """Run jlc.download_one in a thread so it doesn't block the event loop."""
    return await asyncio.to_thread(jlc.download_one, lcsc, target, progress)


async def run_batch(
    lcscs: list[str],
    staging: Path,
    concurrency: int = 4,
    emit: EmitFn | None = None,
    dl: DlFn | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    retry_backoff: float = DEFAULT_RETRY_BACKOFF,
) -> dict:
    """
    Download *lcscs* into *staging/<lcsc>/* directories in parallel.

    Emits ``download-progress`` notifications as each part starts,
    progresses, and finishes, then a final ``download-done`` notification
    with the full results dict.

    NOTE — the event names were originally ``download.progress`` /
    ``download.done`` but Tauri 2's runtime validator rejects names
    containing ``.``, so the events were silently dropped on the Rust
    forwarder side and the frontend's Queue progress UI never updated.
    See ``kibrary_sidecar.event_names`` for the full root-cause writeup.

    Returns a dict mapping lcsc -> {"ok": bool, "error": str|None}.
    """
    sem = asyncio.Semaphore(concurrency)
    dl_fn: DlFn = dl or _default_dl
    results: dict[str, dict] = {}
    loop = asyncio.get_running_loop()

    async def worker(lcsc: str) -> None:
        async with sem:
            if emit:
                await emit(
                    {
                        "event": DOWNLOAD_PROGRESS,
                        "params": {
                            "lcsc": lcsc,
                            "status": "downloading",
                            "progress": 0,
                        },
                    }
                )

            # Bridge sync progress callback (called from a worker thread by
            # jlc.download_one) into an asyncio emit on the event loop.
            def _on_progress(pct: int) -> None:
                if not emit:
                    return
                fut = asyncio.run_coroutine_threadsafe(
                    emit(
                        {
                            "event": DOWNLOAD_PROGRESS,
                            "params": {
                                "lcsc": lcsc,
                                "status": "downloading",
                                "progress": int(pct),
                            },
                        }
                    ),
                    loop,
                )
                # Don't block the worker thread waiting on the result —
                # but do drain the future so its exception doesn't leak.
                try:
                    fut.result(timeout=0.5)
                except Exception:  # pragma: no cover
                    log.debug("progress emit raised", exc_info=True)

            # Bounded retry-with-backoff (CLI parity). A transient
            # JLC2KiCadLib/network failure used to fail the part outright;
            # retry up to *max_attempts* with *retry_backoff* seconds between
            # tries. Only genuine failures retry — an exception, an ok=False
            # return, OR ok=True but nothing landed on disk (jlc swallows
            # easyeda's success=False, so assets_present() is the real
            # post-condition). Success short-circuits immediately.
            attempts = max(1, int(max_attempts))

            async def _attempt() -> tuple[bool, str | None]:
                # Pass progress callback if supported, else fall back gracefully.
                try:
                    return await dl_fn(lcsc, staging / lcsc, progress=_on_progress)
                except TypeError:
                    return await dl_fn(lcsc, staging / lcsc)

            ok, err = False, None
            for attempt in range(1, attempts + 1):
                try:
                    ok, err = await _attempt()
                except asyncio.CancelledError:
                    # Respect cancellation — never swallow it into a retry.
                    raise
                except Exception as exc:  # noqa: BLE001 — third-party can raise anything
                    ok, err = False, f"{type(exc).__name__}: {exc}"

                # Treat ok=True with no assets on disk as a genuine failure
                # worth retrying (the silent easyeda success=False path).
                present = jlc.assets_present(staging / lcsc, lcsc)
                succeeded = ok and any(present.values())
                if succeeded:
                    break
                if attempt < attempts:
                    log.warning(
                        "download attempt %d/%d failed for %s (%s) — retrying in %.1fs",
                        attempt, attempts, lcsc, err or "no assets", retry_backoff,
                    )
                    await asyncio.sleep(retry_backoff)

            # Inspect what actually landed on disk. Even on ok=True some
            # assets might still be absent (e.g. easyeda has a symbol but
            # no 3D model for a given LCSC) — the frontend uses this to
            # surface "footprint missing" amber warnings instead of
            # silently presenting an incomplete part as fully-downloaded.
            assets = jlc.assets_present(staging / lcsc, lcsc)
            missing = _missing_assets(assets)
            warnings = []
            if ok and missing:
                warnings.append(
                    {
                        "kind": "component_load_partial",
                        "lcsc": lcsc,
                        "missing": missing,
                        "assets": assets,
                    }
                )
            elif not ok:
                warnings.append(
                    {
                        "kind": "component_load_failed",
                        "lcsc": lcsc,
                        "missing": missing or ["symbol", "footprint", "3D model"],
                        "assets": assets,
                        "reason": err or "unknown error",
                    }
                )
            results[lcsc] = {
                "ok": ok,
                "error": err,
                "assets": assets,
                "warnings": warnings,
            }

            # Best-effort icon render — never fails the download
            if ok:
                try:
                    await asyncio.to_thread(icons.render_for_part, staging / lcsc, lcsc)
                except Exception as exc:
                    log.warning("Icon render error for %s (non-fatal): %s", lcsc, exc)

                # Best-effort metadata capture — fetch category/description from
                # search.raph.io and write meta.json so downstream UI (e.g.
                # ReviewBulkAssign) can suggest a sensible library name. Without
                # this every part falls back to Misc_KSL because library.suggest
                # gets an empty category. Never fails the download.
                try:
                    api_key = os.environ.get("KIBRARY_SEARCH_API_KEY", "")
                    part = await asyncio.to_thread(_search_client().get_part, lcsc, api_key)
                    if part:
                        # Footprint name is the .pretty/<name>.kicad_mod stem
                        # JLC2KiCadLib produced — surface it so the UI can
                        # show users which footprint they're about to commit.
                        footprint = staging_mod.footprint_name(staging / lcsc)
                        meta = {
                            "lcsc": lcsc,
                            "category": part.get("category"),
                            "subcategory": part.get("subcategory"),
                            "description": part.get("description"),
                            "mpn": part.get("mpn"),
                            "manufacturer": part.get("manufacturer"),
                            "package": part.get("package"),
                            "footprint": footprint,
                        }
                        # Drop None-valued keys so meta.json stays compact.
                        meta = {k: v for k, v in meta.items() if v is not None}
                        await asyncio.to_thread(staging_mod.write_meta, staging / lcsc, meta)
                except Exception as exc:
                    log.warning("Meta fetch error for %s (non-fatal): %s", lcsc, exc)

            if emit:
                await emit(
                    {
                        "event": DOWNLOAD_PROGRESS,
                        "params": {
                            "lcsc": lcsc,
                            "status": "ready" if ok else "failed",
                            "progress": 100,
                            "error": err,
                            "assets": assets,
                            "warnings": warnings,
                        },
                    }
                )

    await asyncio.gather(*(worker(lcsc) for lcsc in lcscs))
    if emit:
        await emit({"event": DOWNLOAD_DONE, "params": {"results": results}})
    return results


# ---------------------------------------------------------------------------
# Async method exposed to the RPC layer
# ---------------------------------------------------------------------------

async def parts_download(p: dict, emit: EmitFn) -> dict:
    """Async RPC handler: download a batch of LCSC parts."""
    res = await run_batch(
        p["lcscs"],
        Path(p["staging_dir"]),
        concurrency=p.get("concurrency", 4),
        emit=emit,
    )
    return {"results": res}


# Async registry imported by rpc.py
ASYNC_REGISTRY: dict[str, Callable] = {
    "parts.download": parts_download,
}
