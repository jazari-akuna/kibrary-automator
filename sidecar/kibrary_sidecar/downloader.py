"""
Parallel download orchestrator for LCSC part assets.

ASYNC_REGISTRY is defined here (not in methods.py, per Task 16 constraints).
rpc.py imports:
  - REGISTRY        from kibrary_sidecar.methods   (sync handlers)
  - ASYNC_REGISTRY  from kibrary_sidecar.downloader (async handlers)
"""

import asyncio
from pathlib import Path
from typing import Awaitable, Callable

from kibrary_sidecar import jlc

EmitFn = Callable[[dict], Awaitable[None]]
DlFn = Callable[[str, Path], Awaitable[tuple[bool, str | None]]]


async def _default_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
    """Run jlc.download_one in a thread so it doesn't block the event loop."""
    return await asyncio.to_thread(jlc.download_one, lcsc, target)


async def run_batch(
    lcscs: list[str],
    staging: Path,
    concurrency: int = 4,
    emit: EmitFn | None = None,
    dl: DlFn | None = None,
) -> dict:
    """
    Download *lcscs* into *staging/<lcsc>/* directories in parallel.

    Emits ``download.progress`` notifications as each part starts and
    finishes, then a final ``download.done`` notification with the full
    results dict.

    Returns a dict mapping lcsc -> {"ok": bool, "error": str|None}.
    """
    sem = asyncio.Semaphore(concurrency)
    dl_fn: DlFn = dl or _default_dl
    results: dict[str, dict] = {}

    async def worker(lcsc: str) -> None:
        async with sem:
            if emit:
                await emit(
                    {
                        "event": "download.progress",
                        "params": {"lcsc": lcsc, "status": "downloading"},
                    }
                )
            ok, err = await dl_fn(lcsc, staging / lcsc)
            results[lcsc] = {"ok": ok, "error": err}
            if emit:
                await emit(
                    {
                        "event": "download.progress",
                        "params": {
                            "lcsc": lcsc,
                            "status": "ready" if ok else "failed",
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
