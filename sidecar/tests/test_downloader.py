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
    assert types.count("download.progress") >= 3
    assert "download.done" in types


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


def test_run_batch_failed_part(tmp_path: Path):
    results = asyncio.run(
        run_batch(["C99"], tmp_path, concurrency=1, dl=fake_dl_failing())
    )
    assert results["C99"]["ok"] is False
    assert results["C99"]["error"] == "intentional failure"


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
    """Empty list should return empty dict and emit only 'download.done'."""
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    results = asyncio.run(
        run_batch([], tmp_path, concurrency=2, emit=emit, dl=fake_dl())
    )
    assert results == {}
    assert len(events) == 1
    assert events[0]["event"] == "download.done"


def test_done_event_contains_all_results(tmp_path: Path):
    """download.done params.results should mirror the return value."""
    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    results = asyncio.run(
        run_batch(["X1", "X2"], tmp_path, concurrency=2, emit=emit, dl=fake_dl())
    )
    done = next(e for e in events if e["event"] == "download.done")
    assert done["params"]["results"] == results


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
    assert "download.done" in types
