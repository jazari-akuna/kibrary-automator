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
from pathlib import Path
from typing import Awaitable, Callable

from kibrary_sidecar import jlc
from kibrary_sidecar import icons

log = logging.getLogger(__name__)

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
) -> dict:
    """
    Download *lcscs* into *staging/<lcsc>/* directories in parallel.

    Emits ``download.progress`` notifications as each part starts,
    progresses, and finishes, then a final ``download.done`` notification
    with the full results dict.

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
                        "event": "download.progress",
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
                            "event": "download.progress",
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

            # Pass progress callback if supported, else fall back gracefully.
            try:
                ok, err = await dl_fn(lcsc, staging / lcsc, progress=_on_progress)
            except TypeError:
                ok, err = await dl_fn(lcsc, staging / lcsc)
            results[lcsc] = {"ok": ok, "error": err}

            # Best-effort icon render — never fails the download
            if ok:
                try:
                    await asyncio.to_thread(icons.render_for_part, staging / lcsc, lcsc)
                except Exception as exc:
                    log.warning("Icon render error for %s (non-fatal): %s", lcsc, exc)

            if emit:
                await emit(
                    {
                        "event": "download.progress",
                        "params": {
                            "lcsc": lcsc,
                            "status": "ready" if ok else "failed",
                            "progress": 100,
                            "error": err,
                        },
                    }
                )

    await asyncio.gather(*(worker(lcsc) for lcsc in lcscs))
    if emit:
        await emit({"event": "download.done", "params": {"results": results}})
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
