import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def run_one(method: str, params: dict | None = None) -> dict:
    proc = subprocess.Popen(
        [sys.executable, "-m", "kibrary_sidecar"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
        text=True,
    )
    req = {"id": 1, "method": method, "params": params or {}}
    out, err = proc.communicate(input=json.dumps(req) + "\n", timeout=5)
    return json.loads(out.strip().splitlines()[-1])

def test_ping_responds_with_pong():
    resp = run_one("system.ping")
    assert resp == {"id": 1, "ok": True, "result": {"pong": True}}

def test_version_responds_with_semver():
    resp = run_one("system.version")
    assert resp["ok"] is True
    assert "version" in resp["result"]


def run_raw(stdin_text: str) -> tuple[list[dict], str]:
    proc = subprocess.Popen(
        [sys.executable, "-m", "kibrary_sidecar"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
        text=True,
    )
    out, err = proc.communicate(input=stdin_text, timeout=5)
    lines = [json.loads(ln) for ln in out.strip().splitlines() if ln.strip()]
    return lines, err


def test_malformed_json_returns_bad_request():
    lines, _err = run_raw("not valid json\n")
    assert lines == [{"id": 0, "ok": False,
                      "error": {"code": "BAD_REQUEST",
                                "message": lines[0]["error"]["message"]}}]
    assert "BAD_REQUEST" == lines[0]["error"]["code"]


def test_unknown_method_returns_unknown_method():
    lines, _err = run_raw('{"id":7,"method":"does.not.exist","params":{}}\n')
    assert lines == [{"id": 7, "ok": False,
                      "error": {"code": "UNKNOWN_METHOD",
                                "message": "does.not.exist"}}]


def test_handler_exception_returns_handler_error_and_traceback_to_stderr(monkeypatch, tmp_path):
    # Inject a failing handler by writing a tiny in-process variant.
    # We can't easily monkeypatch a child process, so instead we exercise
    # the exception path by importing the loop and feeding it via StringIO.
    import io
    from kibrary_sidecar import rpc, methods

    methods.REGISTRY["test.boom"] = lambda _p: (_ for _ in ()).throw(RuntimeError("kaboom"))
    try:
        stdin = io.StringIO('{"id":3,"method":"test.boom","params":{}}\n')
        stdout = io.StringIO()
        stderr = io.StringIO()
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", stdout)
        monkeypatch.setattr(sys, "stderr", stderr)
        rpc.serve()
        resp = json.loads(stdout.getvalue().strip().splitlines()[-1])
        assert resp["id"] == 3
        assert resp["ok"] is False
        assert resp["error"]["code"] == "HANDLER_ERROR"
        assert "kaboom" in resp["error"]["message"]
        # Traceback should appear on stderr, not stdout
        assert "kaboom" in stderr.getvalue()
        assert "Traceback" in stderr.getvalue()
    finally:
        methods.REGISTRY.pop("test.boom", None)
