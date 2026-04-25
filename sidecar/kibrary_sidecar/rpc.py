import json
import sys
import traceback

from kibrary_sidecar.methods import REGISTRY
from kibrary_sidecar.protocol import ErrorBody, Request, Response


def serve() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = Request.model_validate_json(line)
        except Exception as e:
            sys.stdout.write(
                json.dumps(
                    {"id": 0, "ok": False, "error": {"code": "BAD_REQUEST", "message": str(e)}}
                )
                + "\n"
            )
            sys.stdout.flush()
            continue
        handler = REGISTRY.get(req.method)
        if handler is None:
            resp = Response(
                id=req.id,
                ok=False,
                error=ErrorBody(code="UNKNOWN_METHOD", message=req.method),
            )
        else:
            try:
                result = handler(req.params)
                resp = Response(id=req.id, ok=True, result=result)
            except Exception as e:
                print(traceback.format_exc(), file=sys.stderr)
                resp = Response(
                    id=req.id,
                    ok=False,
                    error=ErrorBody(code="HANDLER_ERROR", message=str(e)),
                )
        sys.stdout.write(resp.model_dump_json(exclude_none=True) + "\n")
        sys.stdout.flush()
