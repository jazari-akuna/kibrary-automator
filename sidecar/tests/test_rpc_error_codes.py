"""Unit 2: richer RPC error-code classification.

These drive the in-process dispatch path (same technique as
test_rpc.py::test_handler_exception_...): register a handler that raises a
specific exception, run the loop over a StringIO, and assert error.code.
"""
import io
import json
import sys

import pytest

from kibrary_sidecar import rpc, methods


def _dispatch(raising, monkeypatch):
    methods.REGISTRY["test.err"] = raising
    try:
        stdin = io.StringIO('{"id":9,"method":"test.err","params":{}}\n')
        stdout = io.StringIO()
        stderr = io.StringIO()
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", stdout)
        monkeypatch.setattr(sys, "stderr", stderr)
        rpc.serve()
        resp = json.loads(stdout.getvalue().strip().splitlines()[-1])
        return resp, stderr.getvalue()
    finally:
        methods.REGISTRY.pop("test.err", None)


def _raise(exc):
    def handler(_p):
        raise exc
    return handler


@pytest.mark.parametrize(
    "exc,expected_code",
    [
        (KeyError("workspace"), "INVALID_PARAMS"),
        (TypeError("bad arg"), "INVALID_PARAMS"),
        (ValueError("bad value"), "INVALID_PARAMS"),
        (FileNotFoundError("/missing"), "NOT_FOUND"),
        (PermissionError("denied"), "PERMISSION_DENIED"),
        (RuntimeError("kaboom"), "HANDLER_ERROR"),
    ],
)
def test_error_code_classification(exc, expected_code, monkeypatch):
    resp, _stderr = _dispatch(_raise(exc), monkeypatch)
    assert resp["id"] == 9
    assert resp["ok"] is False
    assert resp["error"]["code"] == expected_code


def test_message_preserved_and_traceback_to_stderr(monkeypatch):
    resp, stderr = _dispatch(_raise(ValueError("specific detail")), monkeypatch)
    assert "specific detail" in resp["error"]["message"]
    assert "Traceback" in stderr
    assert "specific detail" in stderr


def test_unmapped_exception_defaults_to_handler_error(monkeypatch):
    class Weird(Exception):
        pass

    resp, _stderr = _dispatch(_raise(Weird("?")), monkeypatch)
    assert resp["error"]["code"] == "HANDLER_ERROR"
