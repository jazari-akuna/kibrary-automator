"""
Tests for kibrary_sidecar.downloader — uses a fake download function so no
actual JLC2KiCadLib calls are made.
"""

import asyncio
from pathlib import Path

import pytest

from kibrary_sidecar.downloader import run_batch, ASYNC_REGISTRY


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fake_dl(delay: float = 0.01):
    """Return an async download function that always succeeds after *delay* s."""

    async def one(lcsc: str, target: Path) -> tuple[bool, str | None]:
        await asyncio.sleep(delay)
        return True, None

    return one


def fake_dl_failing():
    """Return an async download function that always fails."""

    async def one(lcsc: str, target: Path) -> tuple[bool, str | None]:
        await asyncio.sleep(0.01)
        return False, "intentional failure"

    return one


# ---------------------------------------------------------------------------
# Core spec test from the plan
# ---------------------------------------------------------------------------

def test_run_batch_emits_progress_per_part(tmp_path: Path):
    """Each part emits a 'downloading' notification and a 'ready' one; done at end."""
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    asyncio.run(
        run_batch(
            ["C1", "C2", "C3"],
            tmp_path,
            concurrency=2,
            emit=emit,
            dl=fake_dl(),
        )
    )
    types = [e["event"] for e in events]
    assert types.count("download-progress") >= 3
    assert "download-done" in types


# ---------------------------------------------------------------------------
# Additional tests
# ---------------------------------------------------------------------------

def test_run_batch_returns_results_dict(tmp_path: Path):
    results = asyncio.run(
        run_batch(["C10", "C20"], tmp_path, concurrency=2, dl=fake_dl())
    )
    assert set(results.keys()) == {"C10", "C20"}
    for v in results.values():
        assert v["ok"] is True
        assert v["error"] is None
        # Post-fix: every result also carries the structured assets snapshot
        # and a (possibly empty) warnings list so the frontend can surface
        # partial-asset failures (the C6037812 silent-failure root cause).
        assert "assets" in v
        assert "warnings" in v
        assert isinstance(v["warnings"], list)


def test_run_batch_emits_component_load_failed_warning_on_silent_failure(tmp_path: Path):
    """C6037812 regression: a download that returns ok=False with no files
    on disk must surface a structured ``component_load_failed`` warning so
    the UI banner can render "X not found" instead of a bare ``failed``
    pill.
    """
    async def silent_failing_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        # No files written — exactly the post-fix shape jlc.download_one
        # returns when easyeda.com has no design data for an LCSC.
        target.mkdir(parents=True, exist_ok=True)
        return False, "Component 'C6037812' not found in source library"

    results = asyncio.run(
        run_batch(["C6037812"], tmp_path, concurrency=1, dl=silent_failing_dl)
    )
    row = results["C6037812"]
    assert row["ok"] is False
    assert row["assets"] == {"symbol": False, "footprint": False, "model_3d": False}
    warnings = row["warnings"]
    assert len(warnings) == 1
    w = warnings[0]
    assert w["kind"] == "component_load_failed"
    assert w["lcsc"] == "C6037812"
    assert "symbol" in w["missing"]
    assert "footprint" in w["missing"]
    assert "3D model" in w["missing"]
    assert "not found" in (w["reason"] or "")


def test_run_batch_emits_component_load_partial_when_assets_incomplete(tmp_path: Path):
    """Footprint-only response: symbol+3D missing but ok=True. Surfaces an
    amber 'partial' warning rather than a hard failure."""
    async def partial_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        target.mkdir(parents=True, exist_ok=True)
        # Drop only a footprint — no .kicad_sym, no .3dshapes.
        pretty = target / f"{lcsc}.pretty"
        pretty.mkdir()
        (pretty / "FOO.kicad_mod").write_text("(footprint stub)")
        return True, None

    results = asyncio.run(
        run_batch(["Cpartial"], tmp_path, concurrency=1, dl=partial_dl)
    )
    row = results["Cpartial"]
    assert row["ok"] is True
    assert row["assets"] == {"symbol": False, "footprint": True, "model_3d": False}
    warnings = row["warnings"]
    assert len(warnings) == 1
    assert warnings[0]["kind"] == "component_load_partial"
    assert "symbol" in warnings[0]["missing"]
    assert "3D model" in warnings[0]["missing"]
    assert "footprint" not in warnings[0]["missing"]


def test_run_batch_no_warnings_on_clean_download(tmp_path: Path):
    """A complete sym+footprint+3D download must produce an empty warnings
    list (the banner is gated on length>0, so this is what keeps the UI
    quiet on the happy path)."""
    async def complete_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{lcsc}.kicad_sym").write_text("(kicad_symbol_lib)")
        pretty = target / f"{lcsc}.pretty"
        pretty.mkdir()
        (pretty / "FOO.kicad_mod").write_text("(footprint stub)")
        shapes = target / f"{lcsc}.3dshapes"
        shapes.mkdir()
        (shapes / "FOO.step").write_bytes(b"ISO-10303-21\n")
        return True, None

    results = asyncio.run(
        run_batch(["Ccomplete"], tmp_path, concurrency=1, dl=complete_dl)
    )
    row = results["Ccomplete"]
    assert row["ok"] is True
    assert row["assets"] == {"symbol": True, "footprint": True, "model_3d": True}
    assert row["warnings"] == []


def test_run_batch_terminal_progress_event_carries_assets_and_warnings(tmp_path: Path):
    """Frontend's queue listener uses download-progress's terminal event to
    fill in per-row banners — pin the contract so a future refactor that
    drops the assets/warnings fields gets caught at unit-test time.
    """
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    async def silent_failing_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        target.mkdir(parents=True, exist_ok=True)
        return False, "not found"

    asyncio.run(
        run_batch(["Cmissing"], tmp_path, concurrency=1, emit=emit, dl=silent_failing_dl)
    )
    terminal = next(
        e for e in events
        if e["event"] == "download-progress" and e["params"].get("status") == "failed"
    )
    p = terminal["params"]
    assert p["lcsc"] == "Cmissing"
    assert "assets" in p
    assert "warnings" in p
    assert p["warnings"] and p["warnings"][0]["kind"] == "component_load_failed"


def test_run_batch_failed_part(tmp_path: Path):
    results = asyncio.run(
        run_batch(["C99"], tmp_path, concurrency=1, dl=fake_dl_failing())
    )
    assert results["C99"]["ok"] is False
    assert results["C99"]["error"] == "intentional failure"
    # Failed rows always carry a component_load_failed warning so the UI
    # banner has a structured payload to format (see queue-warning-banner).
    assert results["C99"]["warnings"]
    assert results["C99"]["warnings"][0]["kind"] == "component_load_failed"


def test_run_batch_concurrency_cap(tmp_path: Path):
    """
    With concurrency=1, parts run serially; the semaphore should ensure that
    at most 1 download is active at once.  We verify by recording entry/exit
    times and confirming they don't overlap.
    """
    active: list[int] = []
    max_concurrent: list[int] = [0]
    current: list[int] = [0]

    async def tracking_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        current[0] += 1
        max_concurrent[0] = max(max_concurrent[0], current[0])
        await asyncio.sleep(0.02)
        current[0] -= 1
        return True, None

    asyncio.run(
        run_batch(["A", "B", "C"], tmp_path, concurrency=1, dl=tracking_dl)
    )
    assert max_concurrent[0] == 1


def test_run_batch_concurrency_2(tmp_path: Path):
    """With concurrency=2, at most 2 downloads run simultaneously."""
    max_concurrent: list[int] = [0]
    current: list[int] = [0]

    async def tracking_dl(lcsc: str, target: Path) -> tuple[bool, str | None]:
        current[0] += 1
        max_concurrent[0] = max(max_concurrent[0], current[0])
        await asyncio.sleep(0.02)
        current[0] -= 1
        return True, None

    asyncio.run(
        run_batch(["A", "B", "C", "D"], tmp_path, concurrency=2, dl=tracking_dl)
    )
    assert max_concurrent[0] <= 2


def test_run_batch_no_emit(tmp_path: Path):
    """run_batch works fine when no emit callback is provided."""
    results = asyncio.run(
        run_batch(["C1"], tmp_path, concurrency=1, dl=fake_dl())
    )
    assert results["C1"]["ok"] is True


def test_run_batch_empty(tmp_path: Path):
    """Empty list should return empty dict and emit only 'download-done'."""
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    results = asyncio.run(
        run_batch([], tmp_path, concurrency=2, emit=emit, dl=fake_dl())
    )
    assert results == {}
    assert len(events) == 1
    assert events[0]["event"] == "download-done"


def test_done_event_contains_all_results(tmp_path: Path):
    """download-done params.results should mirror the return value."""
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    results = asyncio.run(
        run_batch(["X1", "X2"], tmp_path, concurrency=2, emit=emit, dl=fake_dl())
    )
    done = next(e for e in events if e["event"] == "download-done")
    assert done["params"]["results"] == results


# ---------------------------------------------------------------------------
# Unit 2: per-part retry with backoff (CLI parity)
# ---------------------------------------------------------------------------

def _counting_dl(fail_times: int, exc: bool = False):
    """Return (dl_fn, calls) where dl_fn fails the first *fail_times* calls
    (per-lcsc) then succeeds. When ``exc`` is True it raises instead of
    returning ok=False."""
    calls: dict[str, int] = {}

    async def one(lcsc: str, target: Path, progress=None) -> tuple[bool, str | None]:
        calls[lcsc] = calls.get(lcsc, 0) + 1
        if calls[lcsc] <= fail_times:
            if exc:
                raise RuntimeError(f"transient boom {calls[lcsc]}")
            return False, f"transient failure {calls[lcsc]}"
        # Success: write the assets run_batch's assets_present() looks for so
        # the part counts as genuinely complete.
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{lcsc}.kicad_sym").write_text("(kicad_symbol_lib)")
        pretty = target / f"{lcsc}.pretty"
        pretty.mkdir()
        (pretty / "FOO.kicad_mod").write_text("(footprint stub)")
        shapes = target / f"{lcsc}.3dshapes"
        shapes.mkdir()
        (shapes / "FOO.step").write_bytes(b"ISO-10303-21\n")
        return True, None

    return one, calls


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch):
    """Mock asyncio.sleep inside downloader so retry backoff is instant."""
    import kibrary_sidecar.downloader as dl_mod

    async def _instant(_seconds):
        return None

    # Only patch the symbol the downloader's retry loop calls.
    monkeypatch.setattr(dl_mod.asyncio, "sleep", _instant)


def test_retry_succeeds_after_transient_failures(tmp_path: Path):
    """Two transient failures then success → part ends ok with 3 attempts."""
    dl_fn, calls = _counting_dl(fail_times=2)
    results = asyncio.run(
        run_batch(["C1"], tmp_path, concurrency=1, dl=dl_fn, max_attempts=3)
    )
    assert calls["C1"] == 3
    assert results["C1"]["ok"] is True
    assert results["C1"]["warnings"] == []


def test_retry_succeeds_after_transient_exceptions(tmp_path: Path):
    """A raised exception is a genuine failure and must be retried too."""
    dl_fn, calls = _counting_dl(fail_times=1, exc=True)
    results = asyncio.run(
        run_batch(["C1"], tmp_path, concurrency=1, dl=dl_fn, max_attempts=3)
    )
    assert calls["C1"] == 2
    assert results["C1"]["ok"] is True


def test_retry_gives_up_after_max_attempts(tmp_path: Path):
    """All attempts fail → exactly max_attempts calls, then the existing
    component_load_failed warning is surfaced (not retried forever)."""
    dl_fn, calls = _counting_dl(fail_times=99)
    results = asyncio.run(
        run_batch(["C1"], tmp_path, concurrency=1, dl=dl_fn, max_attempts=3)
    )
    assert calls["C1"] == 3
    row = results["C1"]
    assert row["ok"] is False
    assert row["warnings"]
    assert row["warnings"][0]["kind"] == "component_load_failed"


def test_no_retry_on_first_success(tmp_path: Path):
    """A part that succeeds immediately is called exactly once (no retry on
    success)."""
    dl_fn, calls = _counting_dl(fail_times=0)
    results = asyncio.run(
        run_batch(["C1"], tmp_path, concurrency=1, dl=dl_fn, max_attempts=3)
    )
    assert calls["C1"] == 1
    assert results["C1"]["ok"] is True


def test_retry_backoff_sleeps_between_attempts(tmp_path: Path, monkeypatch):
    """Backoff is applied between attempts (sleep called attempts-1 times),
    and not after the final attempt."""
    import kibrary_sidecar.downloader as dl_mod

    slept: list[float] = []

    async def _record(seconds):
        slept.append(seconds)

    monkeypatch.setattr(dl_mod.asyncio, "sleep", _record)

    dl_fn, calls = _counting_dl(fail_times=99)
    asyncio.run(
        run_batch(
            ["C1"], tmp_path, concurrency=1, dl=dl_fn,
            max_attempts=3, retry_backoff=2.0,
        )
    )
    # 3 attempts -> 2 backoff sleeps between them, none after the last.
    assert slept == [2.0, 2.0]


def test_default_max_attempts_from_module_constant(tmp_path: Path):
    """When max_attempts isn't passed, the module default (3, CLI parity)
    applies."""
    import kibrary_sidecar.downloader as dl_mod
    assert dl_mod.DEFAULT_MAX_ATTEMPTS == 3

    dl_fn, calls = _counting_dl(fail_times=99)
    asyncio.run(run_batch(["C1"], tmp_path, concurrency=1, dl=dl_fn))
    assert calls["C1"] == 3


def test_async_registry_has_parts_download():
    """ASYNC_REGISTRY must export parts.download as a callable."""
    assert "parts.download" in ASYNC_REGISTRY
    handler = ASYNC_REGISTRY["parts.download"]
    assert callable(handler)


def test_parts_download_handler(tmp_path: Path, monkeypatch):
    """parts_download handler returns {'results': ...} dict (fake dl injected)."""
    import kibrary_sidecar.downloader as dl_mod
    from kibrary_sidecar.downloader import parts_download

    # Monkeypatch the module-level _default_dl so no real JLC call is made.
    monkeypatch.setattr(dl_mod, "_default_dl", fake_dl())

    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    result = asyncio.run(
        parts_download(
            {
                "lcscs": ["C1", "C2"],
                "staging_dir": str(tmp_path),
                "concurrency": 2,
            },
            emit,
        )
    )
    assert "results" in result
    assert set(result["results"].keys()) == {"C1", "C2"}
    types = [e["event"] for e in events]
    assert "download-done" in types
