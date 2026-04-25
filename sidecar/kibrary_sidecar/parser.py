import re
from typing import Any

LCSC_RE = re.compile(r"^C\d+$")
STRICT_BOM_LINE_RE = re.compile(r"^C\d+,\s*\d+$")

def _clean_lines(text: str) -> list[str]:
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out

def _row(lcsc: str, qty: int, ok: bool, error: str | None) -> dict[str, Any]:
    return {"lcsc": lcsc, "qty": qty, "ok": ok, "error": error}

def _parse_bom_line(line: str) -> dict[str, Any]:
    parts = [p.strip() for p in line.split(",")]
    if len(parts) == 1:
        tok = parts[0]
        if LCSC_RE.match(tok):
            return _row(tok, 1, True, None)
        return _row(tok, 0, False, "invalid LCSC")
    if len(parts) == 2:
        tok, qty_s = parts
        if not LCSC_RE.match(tok):
            return _row(tok, 0, False, "invalid LCSC")
        try:
            return _row(tok, int(qty_s), True, None)
        except ValueError:
            return _row(tok, 0, False, "invalid qty")
    return _row(parts[0], 0, False, "too many fields")

def _is_strict_bom(lines: list[str]) -> bool:
    return all(STRICT_BOM_LINE_RE.match(re.sub(r"\s+", "", ln)) for ln in lines)

def parse_input(text: str) -> dict[str, Any]:
    lines = _clean_lines(text)
    if not lines:
        return {"rows": [], "format": "list"}
    if len(lines) >= 2 or _is_strict_bom(lines):
        return {"rows": [_parse_bom_line(ln) for ln in lines], "format": "bom"}
    # Single-line list: split on commas
    tokens = [t.strip() for t in lines[0].split(",") if t.strip()]
    rows = []
    for t in tokens:
        if LCSC_RE.match(t):
            rows.append(_row(t, 1, True, None))
        else:
            rows.append(_row(t, 0, False, "invalid LCSC"))
    return {"rows": rows, "format": "list"}
