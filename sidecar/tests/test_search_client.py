"""Tests for search_client.py — TDD: written before implementation."""
import httpx
import pytest
import respx

from kibrary_sidecar.search_client import get_part, search

BASE = "https://search.raph.io"


# ---------------------------------------------------------------------------
# search()
# ---------------------------------------------------------------------------


@respx.mock
def test_search_calls_api_with_bearer():
    """Happy path: correct endpoint called, Bearer header forwarded, result returned."""
    route = respx.get(f"{BASE}/api/search").mock(
        return_value=httpx.Response(200, json={"results": [{"lcsc": "C1"}]})
    )
    out = search("10k 0402", api_key="abc")
    assert out == {"results": [{"lcsc": "C1"}]}
    assert route.calls[0].request.headers["Authorization"] == "Bearer abc"
    # The query string param must be forwarded
    assert "q=10k" in str(route.calls[0].request.url) or "10k" in str(
        route.calls[0].request.url
    )


def test_search_returns_empty_when_no_api_key():
    """Graceful degradation: empty api_key returns immediately, no network call."""
    assert search("x", api_key="") == {"results": []}


@respx.mock
def test_search_returns_error_on_http_error():
    """500 response is caught and returned as {'results': [], 'error': ...}."""
    respx.get(f"{BASE}/api/search").mock(return_value=httpx.Response(500, text="oops"))
    out = search("resistor", api_key="tok")
    assert out["results"] == []
    assert "error" in out
    assert out["error"]  # non-empty string


@respx.mock
def test_search_returns_error_on_connect_failure():
    """Network error (ConnectError) is caught and returned as {'results': [], 'error': ...}."""
    respx.get(f"{BASE}/api/search").mock(side_effect=httpx.ConnectError("refused"))
    out = search("cap", api_key="tok")
    assert out["results"] == []
    assert "error" in out
    assert out["error"]


# ---------------------------------------------------------------------------
# get_part()
# ---------------------------------------------------------------------------


@respx.mock
def test_get_part_returns_metadata_on_success():
    """200 response body is returned as a dict."""
    payload = {"lcsc": "C25804", "mfr": "YAGEO", "description": "10k 0402"}
    respx.get(f"{BASE}/api/parts/C25804").mock(
        return_value=httpx.Response(200, json=payload)
    )
    result = get_part("C25804", api_key="tok")
    assert result == payload
    # Verify Bearer header
    call = respx.calls[0]
    assert call.request.headers["Authorization"] == "Bearer tok"


@respx.mock
def test_get_part_returns_none_on_404():
    """404 response causes None to be returned (part not found)."""
    respx.get(f"{BASE}/api/parts/CXXXXX").mock(
        return_value=httpx.Response(404, json={"detail": "not found"})
    )
    assert get_part("CXXXXX", api_key="tok") is None


def test_get_part_returns_none_with_empty_api_key():
    """Empty api_key → None immediately, no network call."""
    assert get_part("C25804", api_key="") is None
