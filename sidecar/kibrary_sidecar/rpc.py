"""
JSON-RPC server — reads newline-delimited requests from stdin, writes
responses (and notifications) to stdout.

Sync methods   → kibrary_sidecar.methods.REGISTRY
Async methods  → kibrary_sidecar.downloader.ASYNC_REGISTRY

Threading note
--------------
Sync handlers are dispatched on a small ``ThreadPoolExecutor`` so that
many in-flight calls (e.g. N parallel ``search.fetch_photo`` requests
fired by the SearchPanel) overlap their I/O instead of serialising
behind a single read-eval-respond loop.  Frontend-perceived latency for
N thumbnails drops from ``N × roundtrip`` to ``~max(roundtrip)`` when N
is below the worker count.

Async handlers (run via asyncio.run on the dispatcher thread) may call
the emit callback multiple times before returning.  Both notification
writes and the final response write go through the same
``_stdout_lock`` so that lines are never interleaved on stdout.
"""

import asyncio
import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

from kibrary_sidecar.methods import REGISTRY
from kibrary_sidecar.downloader import ASYNC_REGISTRY
from kibrary_sidecar.protocol import ErrorBody, Notification, Request, Response

# One lock guards all stdout writes (sync responses AND async notifications).
_stdout_lock = threading.Lock()

# Worker pool for sync handlers.  8 is enough to overlap a typical
# search-result page (≤6 thumbnails) without hammering the upstream
# server.  Override via env var for stress tests.
_MAX_WORKERS = int(os.environ.get("KIBRARY_SIDECAR_WORKERS", "8"))


def _write_line(line: str) -> None:
    """Write *line* + newline to stdout, serialised by _stdout_lock."""
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _handle_sync(req: Request) -> None:
    """Dispatch a sync handler and write its response.

    Runs on a worker thread; safe because handler I/O is independent
    per request and `_write_line` is locked.
    """
    handler = REGISTRY[req.method]
    try:
        result = handler(req.params)
        resp = Response(id=req.id, ok=True, result=result)
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr)
        resp = Response(
            id=req.id,
            ok=False,
            error=ErrorBody(code="HANDLER_ERROR", message=str(exc)),
        )
    _write_line(resp.model_dump_json(exclude_none=True))


def _handle_async(req: Request) -> None:
    """Dispatch an async handler and write its response.

    asyncio.run owns its own event loop per call, so multiple concurrent
    async handlers from the worker pool don't conflict.
    """
    async_handler = ASYNC_REGISTRY[req.method]

    async def emit(ev: dict) -> None:
        notif = Notification(
            event=ev["event"],
            params=ev.get("params", {}),
        )
        _write_line(notif.model_dump_json())

    try:
        result = asyncio.run(async_handler(req.params, emit))
        resp = Response(id=req.id, ok=True, result=result)
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr)
        resp = Response(
            id=req.id,
            ok=False,
            error=ErrorBody(code="HANDLER_ERROR", message=str(exc)),
        )
    _write_line(resp.model_dump_json(exclude_none=True))


def serve() -> None:
    executor = ThreadPoolExecutor(
        max_workers=_MAX_WORKERS, thread_name_prefix="rpc-worker"
    )
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue

            # --- parse -------------------------------------------------------
            try:
                req = Request.model_validate_json(line)
            except Exception as exc:
                _write_line(
                    json.dumps(
                        {
                            "id": 0,
                            "ok": False,
                            "error": {"code": "BAD_REQUEST", "message": str(exc)},
                        }
                    )
                )
                continue

            # --- dispatch ----------------------------------------------------
            if req.method in REGISTRY:
                executor.submit(_handle_sync, req)
                continue

            if req.method in ASYNC_REGISTRY:
                executor.submit(_handle_async, req)
                continue

            # --- unknown method ----------------------------------------------
            resp = Response(
                id=req.id,
                ok=False,
                error=ErrorBody(code="UNKNOWN_METHOD", message=req.method),
            )
            _write_line(resp.model_dump_json(exclude_none=True))
    finally:
        # Wait for in-flight handlers so their responses make it to stdout
        # before the process exits.  shutdown(wait=True) is the default but
        # being explicit makes the contract obvious.
        executor.shutdown(wait=True)
