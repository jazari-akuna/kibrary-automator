"""Drag-and-drop import.

Two-stage workflow:
  1. ``scan_paths(paths)`` — walks dropped paths (files OR folders),
     classifies by extension, groups files with the same basename stem
     into one ``DroppedGroup``. The frontend keeps these in memory and
     shows a row per group with a LibPicker.
  2. ``commit_group(workspace, group, target_lib, edits)`` — when the
     user picks a target library and clicks Move, stages the group's
     files into LCSC-style layout under ``.kibrary/staging/`` and hands
     off to the existing ``library.commit_to_library`` machinery so the
     create-new vs merge-into branching, footprint-ref rewriting, 3D
     path rewriting, and KiCad lib-table registration are all reused
     instead of duplicated.

Source files are NEVER moved; ``commit_group`` always copies. The user's
original drop folder is left untouched.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path
from typing import Iterable

from kiutils.footprint import Footprint, Model
from kiutils.symbol import SymbolLib

from kibrary_sidecar import library

log = logging.getLogger(__name__)

_KSL_ROOT = "${KSL_ROOT}"

# Recognised file extensions, lower-case. Anything else falls into `unmatched`.
_SYMBOL_EXTS = {".kicad_sym"}
_FOOTPRINT_EXTS = {".kicad_mod"}
_MODEL_EXTS = {".step", ".stp", ".wrl"}
_RECOGNISED_EXTS = _SYMBOL_EXTS | _FOOTPRINT_EXTS | _MODEL_EXTS


def _classify(path: Path) -> str | None:
    """Return 'symbol' / 'footprint' / 'model' / None for one file path."""
    suf = path.suffix.lower()
    if suf in _SYMBOL_EXTS:
        return "symbol"
    if suf in _FOOTPRINT_EXTS:
        return "footprint"
    if suf in _MODEL_EXTS:
        return "model"
    return None


def _empty_group(name: str, source_dir: str) -> dict:
    return {
        "name": name,
        "symbol_path": None,
        "footprint_path": None,
        "model_paths": [],
        "source_dir": source_dir,
    }


def _scan_dir_into_group(directory: Path, group: dict, unmatched: list[str]) -> bool:
    """Add every recognised file directly inside *directory* (NOT recursively)
    into ``group``. Returns True if any file was added.

    Subdirectories are not recursed here — the caller decides whether
    each subdirectory becomes its own group.
    """
    added = False
    for child in sorted(directory.iterdir()):
        if not child.is_file():
            continue
        kind = _classify(child)
        if kind == "symbol":
            group["symbol_path"] = str(child)
            added = True
        elif kind == "footprint":
            group["footprint_path"] = str(child)
            added = True
        elif kind == "model":
            group["model_paths"].append(str(child))
            added = True
        else:
            unmatched.append(str(child))
    return added


def _walk_folder(directory: Path, folders: list[dict], unmatched: list[str]) -> None:
    """Each folder = one component. Subfolders become their own components.

    Implements the user's spec: "If I drag a folder, you can assume that
    all the files in a same folder are for the same component" — each
    directory's direct children form one group; nested directories
    recurse with the same rule.
    """
    group = _empty_group(name=directory.name, source_dir=str(directory))
    if _scan_dir_into_group(directory, group, unmatched):
        folders.append(group)
    for child in sorted(directory.iterdir()):
        if child.is_dir():
            _walk_folder(child, folders, unmatched)


def scan_paths(paths: list[str]) -> dict:
    """Classify dropped paths into folder-groups + loose files.

    Returns:
        {
          "folders": [DroppedGroup, …],     # one per dropped directory
          "loose_files": [                  # files dropped directly (NOT
            {"kind": "symbol|footprint|model", "path": str},
            …
          ],
          "unmatched": [str, …]
        }

    Grouping rules (per user spec, alpha.3):
      - A dropped FOLDER → one component. All files directly inside it
        belong to that component. Nested subdirectories recurse with
        the same rule (each subdir = its own component).
      - A LOOSE file (dropped directly, not inside a folder) is reported
        in ``loose_files``. The frontend attaches them to the last
        existing component, or starts a new one if none exists.

    Order is preserved: ``folders`` follows the order directories were
    encountered in the drop; ``loose_files`` follows the order they were
    dropped. This stability matters for the sequential-association rule.
    """
    folders: list[dict] = []
    loose_files: list[dict] = []
    unmatched: list[str] = []

    for raw in paths:
        p = Path(raw)
        if not p.exists():
            continue
        if p.is_file():
            kind = _classify(p)
            if kind is None:
                unmatched.append(str(p))
            else:
                loose_files.append({"kind": kind, "path": str(p)})
        elif p.is_dir():
            _walk_folder(p, folders, unmatched)

    return {
        "folders": folders,
        "loose_files": loose_files,
        "unmatched": unmatched,
    }


# ---------------------------------------------------------------------------
# commit_group — copy files into target library via existing commit machinery
# ---------------------------------------------------------------------------


def _stage_group_for_commit(staging_root: Path, group: dict) -> tuple[Path, str]:
    """Lay the dropped group out as if it were an LCSC staged part.

    The existing ``library.commit_to_library`` expects a directory
    ``<staging_root>/<lcsc>/`` containing ``<lcsc>.kicad_sym``,
    ``<lcsc>.pretty/`` and optionally ``<lcsc>.3dshapes/``. We mirror
    that layout under a synthetic ``DROP_<name>`` id so the existing
    create-new / merge-into helpers work without modification.

    Returns ``(staging_part_dir, synthetic_lcsc)``.
    """
    name = group["name"]
    synthetic_lcsc = f"DROP_{name}"
    part_dir = staging_root / synthetic_lcsc

    # Always start from a clean slate — a previous failed commit may have
    # left half-copied files behind.
    if part_dir.exists():
        shutil.rmtree(part_dir)
    part_dir.mkdir(parents=True)

    if group.get("symbol_path"):
        shutil.copy2(group["symbol_path"], part_dir / f"{synthetic_lcsc}.kicad_sym")

    if group.get("footprint_path"):
        pretty = part_dir / f"{synthetic_lcsc}.pretty"
        pretty.mkdir(exist_ok=True)
        # Preserve the dropped footprint's original filename so its
        # internal `(footprint "<name>" …)` token (which KiCad matches
        # against the file basename) keeps lining up.
        shutil.copy2(
            group["footprint_path"],
            pretty / Path(group["footprint_path"]).name,
        )

    model_paths = group.get("model_paths") or []
    if model_paths:
        threed = part_dir / f"{synthetic_lcsc}.3dshapes"
        threed.mkdir(exist_ok=True)
        for src in model_paths:
            shutil.copy2(src, threed / Path(src).name)

    return part_dir, synthetic_lcsc


def _step_bbox_via_ocp(step_path: Path) -> tuple[float, float, float, float, float, float] | None:
    """Read the STEP file via OpenCascade (cadquery-ocp) and return its
    axis-aligned bounding box ``(xmin, ymin, zmin, xmax, ymax, zmax)`` in
    millimetres. Returns ``None`` if OCP isn't available or the file is
    empty/unreadable.

    OCP is an optional dependency (~165MB on disk) — we import lazily so
    sidecar startup is unaffected and so the production .deb (which may
    not bundle OCP for size reasons) still loads drop_import without
    erroring.
    """
    try:
        from OCP.STEPControl import STEPControl_Reader  # type: ignore
        from OCP.IFSelect import IFSelect_RetDone  # type: ignore
        from OCP.Bnd import Bnd_Box  # type: ignore
        from OCP.BRepBndLib import BRepBndLib  # type: ignore
    except Exception as exc:  # noqa: BLE001 — OCP missing is a fallback path
        log.debug("OCP not importable, skipping STEP bbox parse: %s", exc)
        return _step_bbox_via_regex(step_path)

    try:
        reader = STEPControl_Reader()
        status = reader.ReadFile(str(step_path))
        if status != IFSelect_RetDone:
            log.warning("OCP cannot read STEP %s (status=%s)", step_path, status)
            return None
        n_roots = reader.TransferRoots()
        if n_roots == 0:
            log.warning("OCP transferred 0 roots from %s — empty STEP", step_path)
            return None
        shape = reader.OneShape()
        if shape is None or shape.IsNull():
            log.warning("OCP got null shape from %s", step_path)
            return None
        bbox = Bnd_Box()
        BRepBndLib.Add_s(shape, bbox)
        if bbox.IsVoid():
            log.warning("OCP got void bbox from %s — no solids", step_path)
            return None
        return bbox.Get()  # (xmin, ymin, zmin, xmax, ymax, zmax) in mm
    except Exception as exc:  # noqa: BLE001
        log.warning("OCP failed to bbox %s: %s", step_path, exc)
        return None


# Match `CARTESIAN_POINT('label?', (x, y, z))` — STEP files are ASCII and
# coordinate triples appear as bare floats. Robust enough for non-assembly
# STEP files; used only as a fallback when OCP isn't available.
_CART_POINT_RE = re.compile(
    r"CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([^)]+?)\s*\)\s*\)",
    re.IGNORECASE,
)


def _step_bbox_via_regex(step_path: Path) -> tuple[float, float, float, float, float, float] | None:
    """Lightweight STEP bbox without OCP — scans CARTESIAN_POINT entries.

    Limitations:
      - Doesn't apply assembly-level transformations, so for multi-instance
        STEP files (kicad-cli output, large connector models with
        MAPPED_ITEM) this gives the union of *raw* coordinates which can
        be wrong.
      - Doesn't honour LENGTH_UNIT (assumes mm). Fine for single-part STEPs
        from SnapEDA/3D-content-central; wrong for METRE-unit assemblies.

    For Bug 1 (centring chip body on pads) the cases that matter are
    SnapEDA-style single-part STEPs, so this fallback is "good enough"
    when OCP isn't available. When in doubt the caller falls back to (0,0,0).
    """
    try:
        data = step_path.read_text(errors="ignore")
    except Exception as exc:  # noqa: BLE001
        log.warning("regex STEP parse: cannot read %s: %s", step_path, exc)
        return None
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    for match in _CART_POINT_RE.finditer(data):
        parts = [p.strip() for p in match.group(1).split(",")]
        if len(parts) != 3:
            continue
        try:
            x = float(parts[0])
            y = float(parts[1])
            z = float(parts[2])
        except ValueError:
            continue
        xs.append(x)
        ys.append(y)
        zs.append(z)
    if not xs:
        return None
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))


def _footprint_pad_bbox(footprint_path: Path) -> tuple[float, float, float, float] | None:
    """Compute the (xmin, ymin, xmax, ymax) bbox of pad positions in mm.

    Reads the .kicad_mod via kiutils. Pads without ``at`` are skipped.
    Returns ``None`` if the footprint has no pads with positions.

    Falls back to a regex parser when kiutils can't parse the file —
    happens for legacy footprints whose ``(model …)`` block omits an
    ``(offset …)`` sub-S-expr (kiutils raises "Expression does not have
    the correct type"). The auto-offset render path explicitly targets
    that shape, so the fallback is what makes Bug-1 ("chip body off
    centre on legacy footprints") fixable from the render side without
    rewriting the file on disk.
    """
    try:
        fp = Footprint().from_file(str(footprint_path))
    except Exception as exc:  # noqa: BLE001
        log.info(
            "kiutils cannot parse %s for pad bbox (%s); falling back to regex",
            footprint_path, exc,
        )
        return _footprint_pad_bbox_via_regex(footprint_path)

    xs: list[float] = []
    ys: list[float] = []
    for pad in fp.pads:
        pos = getattr(pad, "position", None)
        if pos is None:
            continue
        x = getattr(pos, "X", None)
        y = getattr(pos, "Y", None)
        if x is None or y is None:
            continue
        xs.append(float(x))
        ys.append(float(y))
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


# (pad "<num>" <type> <shape> (at <x> <y> [<rot>]) …) — captures only the
# X and Y of each pad's position. Pad numbers may be quoted or bare; the
# (at …) form may carry an optional rotation we ignore. Used as the kiutils
# fallback for legacy footprints whose (model …) block can't be round-
# tripped through kiutils.
_PAD_AT_RE = re.compile(
    r"\(pad\s+\S+\s+\S+\s+\S+\s+"          # (pad "1" smd rect
    r"(?:[^()]|\([^()]*\))*?"              # any non-(at) sub-tokens before (at …)
    r"\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)",
    re.IGNORECASE | re.DOTALL,
)


def _footprint_pad_bbox_via_regex(
    footprint_path: Path,
) -> tuple[float, float, float, float] | None:
    """Regex-based pad bbox extraction for footprints kiutils rejects.

    Walks every ``(pad … (at X Y [rot]) …)`` form in the file and unions
    the X/Y coordinates. Skips footprints with no parseable pads (returns
    ``None``).
    """
    try:
        text = footprint_path.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        log.warning("regex pad bbox: cannot read %s: %s", footprint_path, exc)
        return None
    xs: list[float] = []
    ys: list[float] = []
    for match in _PAD_AT_RE.finditer(text):
        try:
            xs.append(float(match.group(1)))
            ys.append(float(match.group(2)))
        except ValueError:
            continue
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def compute_step_pad_offset(
    step_path: str | Path,
    footprint_path: str | Path,
) -> tuple[float, float, float]:
    """Return the (x, y, z) offset (in mm) that places the STEP body's
    geometric centre over the centre of the footprint's pad bbox.

    Workflow:
      1. Read pad positions from the .kicad_mod → pad bbox centre.
      2. Read STEP solid bbox → STEP centre.
      3. offset = pad_centre - step_centre  (X, Y only; Z is left at 0
         because the user expects the body to sit ON the board surface,
         not below it; they can adjust Z manually via the positioner UI).

    Falls back to ``(0.0, 0.0, 0.0)`` and emits a warning when:
      - the footprint has no pads with positions
      - the STEP file is .wrl (not parseable for solid bbox)
      - OCP can't read the STEP and the regex fallback finds no points
    """
    step_p = Path(step_path)
    fp_p = Path(footprint_path)

    if step_p.suffix.lower() == ".wrl":
        log.info("WRL files have no parseable bbox; using offset (0,0,0) for %s", step_p.name)
        return (0.0, 0.0, 0.0)

    pad_bb = _footprint_pad_bbox(fp_p)
    if pad_bb is None:
        log.warning(
            "Cannot derive pad bbox for %s — falling back to offset (0,0,0)",
            fp_p.name,
        )
        return (0.0, 0.0, 0.0)

    step_bb = _step_bbox_via_ocp(step_p)
    if step_bb is None:
        log.warning(
            "Cannot derive STEP bbox for %s — falling back to offset (0,0,0)",
            step_p.name,
        )
        return (0.0, 0.0, 0.0)

    pad_cx = (pad_bb[0] + pad_bb[2]) / 2.0
    pad_cy = (pad_bb[1] + pad_bb[3]) / 2.0
    step_cx = (step_bb[0] + step_bb[3]) / 2.0
    step_cy = (step_bb[1] + step_bb[4]) / 2.0

    # KiCad's footprint Y axis points DOWN (PCB convention) but the (model)
    # offset's Y axis points the same way as KiCad's 3D viewer (which uses
    # +Y up). KiCad applies the offset by NEGATING the Y component before
    # translating the STEP. To make the body land at pad_centre we must
    # therefore set offset.y = pad_cy - step_cy (no extra sign flip — the
    # user can correct via the positioner UI if a particular STEP uses an
    # inverted convention).
    return (pad_cx - step_cx, pad_cy - step_cy, 0.0)


def _ensure_model_blocks(
    lib_dir: Path,
    target_lib: str,
    footprint_path: str,
    model_paths: list[str],
) -> None:
    """Synthesize ``(model ...)`` blocks in the committed .kicad_mod for
    each dropped 3D file that isn't already referenced.

    The existing ``library._update_footprint_3d_paths()`` only iterates
    EXISTING ``(model ...)`` blocks. For drag-drop, the dropped .kicad_mod
    typically has no model blocks at all (the user is attaching a 3D file
    that wasn't shipped with the original footprint, e.g. an IPEX
    connector). Without this step, the .step file lands in ``.3dshapes/``
    but the .kicad_mod doesn't reference it → KiCad's PCB editor + the
    in-app 3D viewer both render the chip without its body.

    Mirrors ``model3d_ops._update_kicad_mod()`` but iterates over the
    *user-dropped* file basenames rather than synthesizing one per
    component name.
    """
    if not model_paths or not footprint_path:
        return

    fp_basename = Path(footprint_path).stem
    pretty_dir = lib_dir / f"{target_lib}.pretty"
    mod_path = pretty_dir / f"{fp_basename}.kicad_mod"
    if not mod_path.is_file():
        log.warning(
            "drop.commit_group: cannot find %s in %s — skipping (model ...) block sync",
            mod_path.name,
            pretty_dir,
        )
        return

    # Compute a sane default offset per dropped model so the STEP body's
    # bbox centre lands over the pad bbox centre (Bug 1: "the footprint is
    # on one side, the step in the middle"). Using the SOURCE path on the
    # filesystem because the .step is already copied into .3dshapes/ but
    # the source file is still readable. Both work; source is simpler.
    target_paths_with_offsets: list[tuple[str, tuple[float, float, float]]] = []
    for src in model_paths:
        target = f"{_KSL_ROOT}/{target_lib}/{target_lib}.3dshapes/{Path(src).name}"
        offset = compute_step_pad_offset(src, footprint_path)
        target_paths_with_offsets.append((target, offset))

    target_paths = [t for t, _ in target_paths_with_offsets]

    try:
        fp = Footprint().from_file(str(mod_path))
        existing_paths = {m.path for m in fp.models}
        added = False
        for tp, off in target_paths_with_offsets:
            if tp not in existing_paths:
                model = Model(path=tp)
                # Model.pos has fields X/Y/Z in kiutils
                model.pos.X = off[0]
                model.pos.Y = off[1]
                model.pos.Z = off[2]
                fp.models.append(model)
                added = True
        if added:
            fp.to_file(str(mod_path))
    except Exception as exc:  # noqa: BLE001 — diagnostic, fall through to regex
        log.warning(
            "drop.commit_group: kiutils failed to add (model ...) blocks to %s "
            "(falling back to text-append): %s",
            mod_path,
            exc,
        )
        _regex_append_models(mod_path, target_paths_with_offsets)


def _regex_append_models(
    mod_path: Path,
    target_paths_with_offsets: list[tuple[str, tuple[float, float, float]]],
) -> None:
    """Text-fallback when kiutils can't parse the .kicad_mod.

    Reads the file, checks which target paths are already mentioned (by
    substring match), appends a (model ...) block (with the precomputed
    body-on-pads offset) for each missing one just before the footprint's
    closing paren.
    """
    content = mod_path.read_text()
    appended_any = False
    for tp, off in target_paths_with_offsets:
        if tp in content:
            continue
        ox, oy, oz = off
        block = (
            f"\n  (model {tp}\n"
            f"    (offset (xyz {ox} {oy} {oz}))\n"
            f"    (scale (xyz 1 1 1))\n"
            f"    (rotate (xyz 0 0 0))\n"
            f"  )"
        )
        # Insert before the LAST top-level closing paren (the footprint's).
        last_close = content.rstrip().rfind(")")
        if last_close < 0:
            log.warning("drop.commit_group: %s has no closing paren, skipping append", mod_path)
            return
        content = content[:last_close] + block + "\n" + content[last_close:]
        appended_any = True
    if appended_any:
        mod_path.write_text(content)


def _read_committed_component_name(lib_dir: Path, target_lib: str, fallback: str) -> str:
    """Best-effort lookup of the component name actually written to the lib."""
    sym_file = lib_dir / f"{target_lib}.kicad_sym"
    if not sym_file.is_file():
        return fallback
    try:
        sl = SymbolLib().from_file(str(sym_file))
        # Newly merged symbol is appended last; create-new path also leaves
        # only one symbol when starting from a single-symbol drop.
        if sl.symbols:
            return sl.symbols[-1].entryName or fallback
    except Exception as exc:  # noqa: BLE001 — diagnostic, fall back to stem
        log.warning("drop.commit_group: symbol-name lookup failed: %s", exc)
    return fallback


def commit_group(
    workspace: Path,
    group: dict,
    target_lib: str,
    edits: dict | None = None,
) -> dict:
    """Copy a dropped group into ``target_lib`` and return navigation hints.

    The group must have been produced by ``scan_paths`` (or share its
    schema). ``target_lib`` is the destination library name; if the
    library doesn't exist it's created, otherwise the symbol is appended.

    Returns ``{committed_path, component_name, target_lib}`` so the
    frontend's "Open in library" button can pre-select the new entry.
    """
    if not group.get("symbol_path") and not group.get("footprint_path"):
        # Without at least a symbol or footprint there is nothing to
        # commit — a 3D-model-only drop has no library entry to open.
        raise ValueError(
            "Drop group has no symbol or footprint — at least one is required to commit"
        )

    staging_root = workspace / ".kibrary" / "staging"
    staging_root.mkdir(parents=True, exist_ok=True)

    part_dir, synthetic_lcsc = _stage_group_for_commit(staging_root, group)

    try:
        lib_dir = library.commit_to_library(
            workspace=workspace,
            lcsc=synthetic_lcsc,
            staging_part=part_dir,
            target_lib=target_lib,
            edits=edits or {},
        )
    finally:
        # Best-effort cleanup — commit_to_library moves most files out via
        # shutil.move on the create-new path, but the merge-into path
        # leaves the staging dir intact. Either way, drop the staging dir
        # so re-commits start clean and we don't leak disk space.
        if part_dir.exists():
            shutil.rmtree(part_dir, ignore_errors=True)

    # Synthesize (model …) blocks for any dropped 3D file the .kicad_mod
    # doesn't already reference. library._update_footprint_3d_paths only
    # rewrites EXISTING blocks; drag-drop typically attaches 3D files to
    # footprints that have no model block at all (the user-reported
    # IPEX_20952 case). Without this, the .step lands in .3dshapes/ but
    # KiCad's PCB editor + the in-app viewer both render an empty footprint.
    if group.get("model_paths") and group.get("footprint_path"):
        _ensure_model_blocks(
            lib_dir=lib_dir,
            target_lib=target_lib,
            footprint_path=group["footprint_path"],
            model_paths=group["model_paths"],
        )

    component_name = _read_committed_component_name(lib_dir, target_lib, group["name"])

    return {
        "committed_path": str(lib_dir),
        "component_name": component_name,
        "target_lib": target_lib,
    }
