#!/usr/bin/env python3
"""fill_datasheets.py — fill in missing datasheet links across all libraries.

Scans every library in the kibrary-automator repository (the same
`library_root` that kibrary_automator.py remembers in its config file) and,
for each symbol whose Datasheet field is not already a PDF link, resolves
the real datasheet through the LCSC API using the symbol's LCSC part number.
Every candidate link is validated (a redirect landing on the LCSC homepage
counts as broken) before it is written.

Pure standard library, Python 3.8+ — runnable with any python3, no venv.

Usage:
  python3 fill_datasheets.py [--library-root PATH] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

APP_NAME      = "kibrary-automator"
REQUEST_DELAY = 0.4   # politeness pause between LCSC requests (seconds)


# ---------------------------------------------------------------------------
# Configuration (same file and format as kibrary_automator.py)
# ---------------------------------------------------------------------------

def config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_CONFIG_HOME", "") or str(Path.home() / ".config")
    return Path(base) / APP_NAME


def config_file() -> Path:
    return config_dir() / "config.yaml"


def load_config() -> dict:
    """Read the config file. Only flat `key: value` pairs are supported."""
    cfg = {}
    path = config_file()
    if not path.is_file():
        return cfg
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if sep:
            cfg[key.strip()] = value.strip().strip("'\"")
    return cfg


def resolve_library_root(override) -> Path:
    if override:
        root = Path(override).expanduser().resolve()
        if not root.is_dir():
            sys.exit(f"Error: --library-root {root} is not a directory.")
        return root
    stored = load_config().get("library_root")
    if not stored:
        sys.exit("No library repository configured yet.\n"
                 f"Run kibrary_automator.py once to set it up "
                 f"(config: {config_file()}),\n"
                 "or pass --library-root PATH.")
    root = Path(stored).expanduser()
    if not root.is_dir():
        sys.exit(f"Configured library path no longer exists: {root}\n"
                 "Fix it in the config file or pass --library-root PATH.")
    return root


def list_libraries(root: Path) -> list:
    """Names of library folders in the repo (containing <name>.kicad_sym)."""
    return sorted(
        d.name for d in root.iterdir()
        if d.is_dir() and (d / f"{d.name}.kicad_sym").is_file()
    )


# ---------------------------------------------------------------------------
# LCSC requests (cached, throttled)
# ---------------------------------------------------------------------------

_pdf_cache = {}    # part number -> pdfUrl or None
_ok_cache  = {}    # url -> bool
_last_net  = 0.0


def _polite_pause() -> None:
    wait = REQUEST_DELAY - (time.monotonic() - _last_net)
    if wait > 0:
        time.sleep(wait)


def _stamp() -> None:
    global _last_net
    _last_net = time.monotonic()


def resolve_datasheet_url(part: str):
    """Ask LCSC for the part's datasheet PDF (one retry on network errors)."""
    if part in _pdf_cache:
        return _pdf_cache[part]
    req = urllib.request.Request(
        f"https://wmsc.lcsc.com/ftps/wm/product/detail?productCode={part}",
        headers={"User-Agent": "Mozilla/5.0"})
    url = None
    for attempt in (1, 2):
        _polite_pause()
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode())
            _stamp()
            url = (data.get("result") or {}).get("pdfUrl") or None
            break
        except Exception:
            _stamp()
            if attempt == 1:
                time.sleep(1.0)
    _pdf_cache[part] = url
    return url


def url_ok(url: str) -> bool:
    """Check that a URL actually resolves before linking it.

    LCSC redirects unknown resources to its homepage instead of 404ing,
    so a redirect that lands on a bare domain root counts as broken.
    """
    if url in _ok_cache:
        return _ok_cache[url]
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    _polite_pause()
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            landed = urllib.parse.urlsplit(resp.geturl()).path
            ok = resp.status == 200 and landed not in ("", "/")
    except Exception:
        ok = False
    _stamp()
    _ok_cache[url] = ok
    return ok


# ---------------------------------------------------------------------------
# Symbol-file surgery (top-level blocks only, byte-preserving)
# ---------------------------------------------------------------------------

def split_top_level_symbols(text: str):
    """Split the file into segments that concatenate back to `text`.

    Returns (segments, block_indices): segments is a list of strings, and
    block_indices lists the positions in it that are complete top-level
    `(symbol ...)` blocks — the direct children of (kicad_symbol_lib ...).
    Sub-symbols like "NAME_0_1" sit at deeper paren depth inside a block,
    so they are never split out or matched on their own.
    """
    segs, block_ids = [], []
    depth = 0
    in_str = esc = False
    seg_start = 0
    block_start = None
    for i, c in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "(":
            if depth == 1 and block_start is None \
                    and re.match(r'\(\s*symbol[\s"(]', text[i:i + 12]):
                block_start = i
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 1 and block_start is not None:
                segs.append(text[seg_start:block_start])
                segs.append(text[block_start:i + 1])
                block_ids.append(len(segs) - 1)
                seg_start = i + 1
                block_start = None
    segs.append(text[seg_start:])
    return segs, block_ids


def sexpr_end(text: str, start: int):
    """Index just past the ')' closing the s-expression opening at `start`."""
    depth = 0
    in_str = esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
    return None


def symbol_name(block: str) -> str:
    m = re.match(r'\(\s*symbol\s+"([^"]*)"', block)
    return m.group(1) if m else "?"


def block_property(block: str, name: str):
    """Property value inside this block, or None when the property is absent."""
    m = re.search(r'\(property\s+"%s"\s+"([^"]*)"' % re.escape(name), block)
    return m.group(1) if m else None


def replace_datasheet(block: str, url: str) -> str:
    return re.sub(r'(\(property\s+"Datasheet"\s+")[^"]*(")',
                  lambda m: m.group(1) + url + m.group(2), block, count=1)


def insert_datasheet(block: str, url: str):
    """Insert a Datasheet property right after the Footprint property."""
    m = re.search(r'\(property\s+"Footprint"', block)
    if not m:
        return None
    end = sexpr_end(block, m.start())
    if end is None:
        return None
    line_start = block.rfind("\n", 0, m.start()) + 1
    indent = re.match(r"[ \t]*", block[line_start:]).group(0)
    prop = (f'\n{indent}(property "Datasheet" "{url}" (at 0 0 0) '
            f'(effects (font (size 1.27 1.27)) hide))')
    return block[:end] + prop + block[end:]


# ---------------------------------------------------------------------------
# Per-symbol decision
# ---------------------------------------------------------------------------

def process_block(block: str):
    """Return (new_block_or_None, status, detail) for one top-level symbol."""
    datasheet = block_property(block, "Datasheet")   # None = property absent
    if datasheet and ".pdf" in datasheet.lower():
        return None, "ok", "datasheet already set"

    part = block_property(block, "LCSC")
    if not part:
        return None, "skipped", "no LCSC part number"

    url = resolve_datasheet_url(part)
    if url and not url_ok(url):
        url = None

    if url:
        if datasheet is None:
            new = insert_datasheet(block, url)
            if new is None:
                return (None, "skipped",
                        "no Footprint property to anchor insertion")
            return new, "filled", url
        return replace_datasheet(block, url), "filled", url

    if datasheet == "":
        fallback = f"https://www.lcsc.com/product-detail/{part}.html"
        if url_ok(fallback):
            return replace_datasheet(block, fallback), "fallback-page", fallback
        return None, "not-found", f"{part}: no working link found"

    if datasheet:
        return None, "not-found", f"{part}: no PDF found — existing link kept"
    return None, "not-found", f"{part}: no working link found"


# ---------------------------------------------------------------------------
# Main scan
# ---------------------------------------------------------------------------

def process_library(root: Path, lib: str, dry_run: bool, counts: dict) -> None:
    sym_file = root / lib / f"{lib}.kicad_sym"
    try:
        text = sym_file.read_bytes().decode("utf-8")
    except Exception as exc:
        print(f"[{lib}] cannot read {sym_file.name}: {exc}")
        counts["error"] = counts.get("error", 0) + 1
        return

    segs, block_ids = split_top_level_symbols(text)
    if not block_ids:
        print(f"[{lib}] no symbols found in {sym_file.name}")
        return

    changed = False
    for idx in block_ids:
        block = segs[idx]
        name = symbol_name(block)
        new_block, status, detail = process_block(block)
        counts[status] = counts.get(status, 0) + 1
        if new_block is not None and new_block != block:
            segs[idx] = new_block
            changed = True
        print(f"[{lib}] {name}: {status} — {detail}")

    if changed and not dry_run:
        sym_file.write_bytes("".join(segs).encode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(
        prog=Path(sys.argv[0]).name,
        description="Fill in missing datasheet links in every KiCad library "
                    "of the configured repository.")
    parser.add_argument("--library-root", metavar="PATH",
                        help="use this library repository instead of the "
                             "configured one")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change without writing")
    args = parser.parse_args()

    root = resolve_library_root(args.library_root)
    print(f"Library repository: {root}")

    libs = list_libraries(root)
    if not libs:
        print("No libraries found — nothing to do.")
        return

    counts = {}
    for lib in libs:
        process_library(root, lib, args.dry_run, counts)

    total = sum(counts.values())
    summary = ", ".join(f"{counts[k]} {k}" for k in sorted(counts))
    tag = " (dry run — nothing written)" if args.dry_run else ""
    print(f"\n{total} symbols in {len(libs)} libraries: {summary}{tag}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
