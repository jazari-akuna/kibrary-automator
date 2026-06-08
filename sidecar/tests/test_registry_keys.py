"""Snapshot guard for the merged sync RPC dispatch table.

``methods.REGISTRY`` is assembled from the per-domain handler maps under
``kibrary_sidecar.handlers``. This test pins the exact set of method-name keys
so the domain split (and any future handler refactor) can't silently drop,
rename, or duplicate-overwrite an RPC method.

The expected set was snapshotted from the pre-refactor single-module
``methods.REGISTRY``.
"""

from kibrary_sidecar import methods

EXPECTED_KEYS = {
    "bootstrap.detect",
    "bootstrap.install",
    "drop.commit_group",
    "drop.scan_paths",
    "editor.open",
    "git.init",
    "git.is_safe",
    "git.undo_last",
    "kicad.detect",
    "kicad.get_active",
    "kicad.list_registered",
    "kicad.refresh",
    "kicad.register",
    "kicad.register_custom_install",
    "kicad.set_active",
    "kicad.unregister",
    "library.add_3d",
    "library.backfill_icons",
    "library.check_duplicate",
    "library.commit",
    "library.delete_component",
    "library.diff",
    "library.get_3d_info",
    "library.get_component",
    "library.get_component_icon",
    "library.lcsc_index",
    "library.list",
    "library.list_components",
    "library.move_component",
    "library.read_file_content",
    "library.read_props",
    "library.rename_component",
    "library.rename_library",
    "library.render_3d_glb_angled",
    "library.render_3d_png",
    "library.render_3d_png_angled",
    "library.render_footprint_svg",
    "library.render_symbol_svg",
    "library.replace_3d",
    "library.set_3d_offset",
    "library.suggest",
    "library.update_metadata",
    "library.write_props",
    "parts.delete_staged",
    "parts.get_icon",
    "parts.list_dir",
    "parts.parse_input",
    "parts.read_file",
    "parts.read_meta",
    "parts.read_props",
    "parts.render_footprint_svg",
    "parts.render_symbol_svg",
    "parts.write_meta",
    "parts.write_props",
    "search.fetch_photo",
    "search.get_part",
    "search.prefetch_photos",
    "search.query",
    "secrets.delete",
    "secrets.get",
    "secrets.set",
    "settings.get",
    "settings.set",
    "system.ping",
    "system.version",
    "workspace.export_zip",
    "workspace.open",
    "workspace.set_settings",
    "workspace.settings",
}


def test_registry_key_set_is_exactly_the_snapshot():
    assert set(methods.REGISTRY.keys()) == EXPECTED_KEYS


def test_no_domain_map_silently_overwrote_another():
    """The merged size must equal the sum of the per-domain map sizes — a
    duplicate key across two domain modules would shrink the merge."""
    from kibrary_sidecar.handlers import (
        system,
        workspace,
        settings,
        kicad,
        parts,
        library,
        render,
        search,
        drop_import,
    )

    domain_total = sum(
        len(m.REGISTRY)
        for m in (
            system,
            workspace,
            settings,
            kicad,
            parts,
            library,
            render,
            search,
            drop_import,
        )
    )
    assert domain_total == len(methods.REGISTRY) == len(EXPECTED_KEYS)


def test_all_registry_values_are_callable():
    for name, handler in methods.REGISTRY.items():
        assert callable(handler), f"{name} handler is not callable"
