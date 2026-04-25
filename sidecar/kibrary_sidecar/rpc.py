"""
JSON-RPC server — reads newline-delimited requests from stdin, writes
responses (and notifications) to stdout.

Sync methods   → kibrary_sidecar.methods.REGISTRY
Async methods  → kibrary_sidecar.downloader.ASYNC_REGISTRY

Threading note
--------------
Async handlers (run via asyncio.run) may call the emit callback multiple
times before returning.  Both notification writes and the final response
write go through the same ``_stdout_lock`` so that lines are never
interleaved on stdout.
"""

import asyncio
import json
import sys
import threading
import traceback

from kibrary_sidecar.methods import REGISTRY
from kibrary_sidecar.downloader import ASYNC_REGISTRY
from kibrary_sidecar.protocol import ErrorBody, Notification, Request, Response

# One lock guards all stdout writes (sync responses AND async notifications).
_stdout_lock = threading.Lock()


def _write_line(line: str) -> None:
    """Write *line* + newline to stdout, serialised by _stdout_lock."""
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def serve() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        # --- parse -----------------------------------------------------------
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

        # --- dispatch sync ---------------------------------------------------
        if req.method in REGISTRY:
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
            continue

        # --- dispatch async --------------------------------------------------
        if req.method in ASYNC_REGISTRY:
            async_handler = ASYNC_REGISTRY[req.method]

            async def emit(ev: dict) -> None:
                """Write a Notification line; lock is held inside _write_line."""
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
            continue

        # --- unknown method --------------------------------------------------
        resp = Response(
            id=req.id,
            ok=False,
            error=ErrorBody(code="UNKNOWN_METHOD", message=req.method),
        )
        _write_line(resp.model_dump_json(exclude_none=True))
