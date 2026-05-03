#!/usr/bin/env python3
"""Generate a synthetic STEP file whose meshes deliberately collide with
the substrate-detection heuristic in Model3DViewerGL.

The frontend looks for the PCB substrate by name pattern (/pcb/i) and
falls back to the largest XZ-area mesh. Bug A: when a chip body has the
substring "PCB" in its label, the heuristic picks the chip as the
substrate and the jog ends up moving the board instead of the chip.

This file builds a small connector-shaped assembly with two named
solids:
  * ``housing_PCB_BODY``         - a tall chip body. Has "PCB" in its
    name on purpose. Must not be classified as the substrate.
  * ``connector_substrate_PLATE`` - a thin board slab. Distinct from
    kicad-cli's auto-generated ``preview_PCB`` substrate mesh, so the
    GLB ends up with three meshes (chip + connector slab + auto board)
    and the exact-name detection still picks the auto ``preview_PCB``.

Why is the second solid NOT named ``preview_PCB``?
    ``kicad-cli pcb export glb`` auto-generates a substrate mesh named
    ``preview_PCB`` for every board it renders. If a fixture solid is
    also named ``preview_PCB``, the GLB ends up with two nodes called
    ``preview_PCB`` (or ``preview_PCB_1``), confusing
    ``findSubstrateMesh``. Using ``connector_substrate_PLATE`` keeps
    the chip-substrate election unambiguous: the exact-match
    ``preview_PCB`` node is uniquely the auto-generated one.

Why XCAF and not ``cq.Assembly.save()``?
    Cadquery's ``Assembly.save(exportType="STEP")`` writes a 2-level
    ``NEXT_ASSEMBLY_USAGE_OCCURRENCE`` hierarchy whose leaves are named
    ``housing_PCB_BODY_part`` and ``connector_substrate_PLATE_part``.
    When ``kicad-cli pcb export glb`` ingests that STEP, OCCT's
    ``RWGltf_CafWriter`` skips both leaves with the warning
    "skipped node '..._part' without triangulation data" and emits a
    GLB containing only the auto-generated board substrate. We bypass
    this by writing each labelled shape at the root of the XCAF doc,
    using ``STEPCAFControl_Writer`` directly. See
    ``/root/kibrary-private/3d-fix-journal/03-synthetic-step-investigation.md``.

Run::

    bash e2e/fixtures/install-deps.sh
    source e2e/fixtures/.venv/bin/activate
    python3 e2e/fixtures/synthetic_pcb_named/gen_step.py

Output: ``synthetic_pcb_named.step`` next to this script.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cadquery as cq
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool

OUT = Path(__file__).resolve().parent / "synthetic_pcb_named.step"


def _build_solids() -> tuple[cq.Workplane, cq.Workplane]:
    # Chip body: 8x8x4 mm. Larger XY than the connector slab below, so a
    # naive "largest XZ area" rule would mis-pick it as the PCB.
    chip = cq.Workplane("XY").box(8.0, 8.0, 4.0).translate((0, 0, 2.0))

    # Connector substrate slab: 6x6x0.6 mm. Deliberately NOT named
    # ``preview_PCB`` to avoid a name collision with kicad-cli's
    # auto-generated board substrate mesh.
    plate = cq.Workplane("XY").box(6.0, 6.0, 0.6).translate((0, 0, 0.3))
    return chip, plate


def _write_step_with_names(out_path: Path) -> None:
    """Write a STEP with two labelled solids at the XCAF root.

    Using ``STEPCAFControl_Writer`` + ``ShapeTool.AddShape(..., False)``
    keeps each solid as a top-level free-shape with a ``TDataStd_Name``
    label rather than wrapping them in a ``NEXT_ASSEMBLY_USAGE`` chain.
    The resulting STEP round-trips through ``kicad-cli pcb export glb``
    with both solids tessellated and node names preserved as
    ``housing_PCB_BODY`` and ``connector_substrate_PLATE``.
    """
    chip, plate = _build_solids()

    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    app.NewDocument(TCollection_ExtendedString("MDTV-XCAF"), doc)

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    chip_label = shape_tool.AddShape(chip.val().wrapped, False)
    TDataStd_Name.Set_s(chip_label, TCollection_ExtendedString("housing_PCB_BODY"))

    plate_label = shape_tool.AddShape(plate.val().wrapped, False)
    TDataStd_Name.Set_s(plate_label, TCollection_ExtendedString("connector_substrate_PLATE"))

    writer = STEPCAFControl_Writer()
    writer.Transfer(doc)
    status = writer.Write(str(out_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEPCAFControl_Writer.Write returned {status!r}")


def main() -> int:
    _write_step_with_names(OUT)
    size = OUT.stat().st_size
    print(f"[gen_step] wrote {OUT} ({size} bytes)")
    if size < 1024:
        print("[gen_step] WARN: file smaller than 1 KiB, likely broken", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
