#!/usr/bin/env python3
import os, sys, shutil, json, zipfile, subprocess, re

ROOT       = os.getcwd()
LIB_SUFFIX = "_KSL"   # change this if needed
GH_USER    = "jazari-akuna"
# Environment variable for 3D-model root
ENV_VAR    = "${KSL_ROOT}"

def run_jlc(parts):
    cmd = ["JLC2KiCadLib"] + parts + [
        "-dir", ".", "-symbol_lib_dir", ".", "-footprint_lib", ".", "-model_dir", "."
    ]
    subprocess.check_call(cmd)

def wrap_assets():
    for fn in os.listdir("."):
        if fn.endswith(".kicad_mod"):
            b = fn.rsplit(".",1)[0]; d = f"{b}.pretty"
            os.makedirs(d, exist_ok=True)
            shutil.move(fn, os.path.join(d, fn))
        if fn.lower().endswith((".wrl",".step",".stp",".3ds")):
            b = fn.rsplit(".",1)[0]; d = f"{b}.3dshapes"
            os.makedirs(d, exist_ok=True)
            shutil.move(fn, os.path.join(d, fn))

def update_paths(sym_file, lib_name, fp_dir, model_dir):
    t = open(sym_file).read()
    t = t.replace('".:', f'"{lib_name}:').replace('".', f'"{lib_name}:')
    if model_dir:
        base3d = os.path.basename(model_dir)
        t = t.replace('3dshapes/', f'{base3d}/')
    open(sym_file, "w").write(t)

def update_footprint_3d_paths(fp_dir, model_dir):
    if not model_dir or not os.path.isdir(fp_dir):
        return
    lib_folder = os.path.basename(os.path.dirname(model_dir))
    base3d     = os.path.basename(model_dir)
    for fn in os.listdir(fp_dir):
        if not fn.endswith(".kicad_mod"):
            continue
        path = os.path.join(fp_dir, fn)
        out = []
        for ln in open(path):
            if ln.lstrip().startswith("(model ") and ENV_VAR not in ln:
                m = re.match(r'\s*\(model\s+[./\\]*([^"\s)]+)', ln)
                if m:
                    fn3d = m.group(1)
                    ln = f"(model {ENV_VAR}/{lib_folder}/{base3d}/{fn3d}\n"
            out.append(ln)
        open(path,"w").writelines(out)


def edit_symbol_description(sym_file):
    import re

    lines = open(sym_file).read().splitlines()

    # 1) read current
    curr = next(
        (m.group(1)
         for ln in lines
         if (m := re.match(r'\s*\(property\s+"Description"\s+"([^"]*)"', ln))),
        ""
    )
    ans = input(f"Component description [{curr}]: ").strip() or curr

    # 2) if exists, just replace
    if any('(property "Description"' in ln for ln in lines):
        out = []
        for ln in lines:
            if '(property "Description"' in ln:
                ln = re.sub(
                    r'\(property\s+"Description"\s+"[^"]*"',
                    f'(property "Description" "{ans}"',
                    ln
                )
            out.append(ln)
        open(sym_file, "w").write("\n".join(out) + "\n")
        print(f"→ Description set to: {ans}")
        return

    # 3) find the first (symbol …) block and its closing line
    start = None
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("(symbol "):
            start = i
            break
    if start is None:
        sys.exit("Cannot find a symbol block to insert Description into.")

    # track parentheses depth within that symbol
    depth = lines[start].count("(") - lines[start].count(")")
    end = None
    for j in range(start + 1, len(lines)):
        depth += lines[j].count("(") - lines[j].count(")")
        if depth == 0:
            end = j
            break
    if end is None:
        sys.exit("Malformed symbol: unbalanced parentheses.")

    # 4) detect indent from existing properties under symbol
    prop_indent = ""
    for ln in lines[start+1:end]:
        m = re.match(r'^(\s*)\(property\s+"', ln)
        if m:
            prop_indent = m.group(1)
            break
    if not prop_indent:
        # fallback: two spaces deeper than symbol line
        sym_indent = re.match(r'^(\s*)', lines[start]).group(1)
        prop_indent = sym_indent + "  "

    # 5) build the block
    i1 = prop_indent + "  "
    i2 = prop_indent + "    "
    block = [
        f'{prop_indent}(property "Description" "{ans}"',
        f'{i1}(at 0 0 0)',
        f'{i1}(effects',
        f'{i2}(font (size 1.27 1.27))',
        f'{i2}(hide yes)',
        f'{i1})',
        f'{prop_indent})'
    ]

    # 6) splice it in just before the closing line of the symbol
    out = lines[:end] + block + lines[end:]
    open(sym_file, "w").write("\n".join(out) + "\n")
    print(f"→ Description set to: {ans}")

def set_default_designator(sym_file):
    lines = open(sym_file).read().splitlines()
    cur = next((m.group(1)
               for ln in lines
               if (m := re.match(r'\s*\(property\s+"Reference"\s+"([^"]+)"', ln))),
              "")
    ans = input(f"Default reference [{cur}]: ").strip().upper()
    new = (ans or cur)
    if new and not new.endswith("?"): new += "?"
    out = []
    for ln in lines:
        if '(property "Reference"' in ln:
            ln = re.sub(r'\(property\s+"Reference"\s+"[^"]+"',
                        f'(property "Reference" "{new}"', ln)
        out.append(ln)
    open(sym_file, "w").write("\n".join(out) + "\n")
    print(f"→ Reference set to: {new}")

def find_local_component():
    syms  = [f for f in os.listdir(".") if f.endswith(".kicad_sym")]
    prets = [d for d in os.listdir(".") if d.endswith(".pretty")]
    if len(syms)==1 and len(prets)==1:
        comp = {"sym": syms[0], "pretty": prets[0]}
        models = [d for d in os.listdir(".") if d.endswith(".3dshapes")]
        if models: comp["models"] = models[0]
        return comp
    return None

def check_duplicate(comp):
    lines = open(comp["sym"]).read().splitlines()
    name = next((re.match(r'\(symbol\s+"([^"]+)"', ln.lstrip()).group(1)
                 for ln in lines if ln.lstrip().startswith("(symbol ")), None)
    if not name: return
    for lib in os.listdir(ROOT):
        lib_sym = os.path.join(ROOT, lib, f"{lib}.kicad_sym")
        if os.path.isfile(lib_sym) and f'(symbol "{name}"' in open(lib_sym).read():
            ans = input(f"Component {name} exists in '{lib}'. Add anyway? [y/N]: ").lower()
            if ans != "y":
                print("→ Aborting.")
                cleanup_downloads(comp)
                sys.exit(0)
            return

def choose_library():
    libs = [
        d for d in os.listdir(ROOT)
        if os.path.isdir(os.path.join(ROOT, d))
        and os.path.isfile(os.path.join(ROOT, d, f"{d}.kicad_sym"))
    ]
    choices = ["Create new library"] + libs
    print("\nAdd to an existing library or create a new one:")
    for i, name in enumerate(choices, 1):
        print(f" {i} - {name}")
    sel = input(f"Select [1]: ").strip()
    if not sel or not sel.isdigit():
        return None
    idx = int(sel)
    if idx < 1 or idx > len(choices):
        print("Invalid choice → defaulting to create new")
        return None
    if idx == 1:
        return None
    return libs[idx - 2]

def merge_into(lib, comp):
    print(f"Merging '{comp['sym']}' into '{lib}'")
    lib_sym = os.path.join(lib, f"{lib}.kicad_sym")
    lines   = open(lib_sym).read().splitlines()
    if lines[-1].strip() != ")":
        sys.exit(f"Bad format in {lib_sym}")
    header = lines[:-1]
    new    = open(comp["sym"]).read().splitlines()
    start  = next(i for i, ln in enumerate(new) if ln.lstrip().startswith("(symbol "))
    inner  = new[start:-1]
    merged = header + [""] + ["  "+ln for ln in inner] + [")"]
    open(lib_sym, "w").write("\n".join(merged) + "\n")

    dst_fp = os.path.join(lib, f"{lib}.pretty")
    for fn in os.listdir(comp["pretty"]):
        if fn.endswith(".kicad_mod"):
            shutil.copy(os.path.join(comp["pretty"], fn), dst_fp)

    dst_3d = None
    if comp.get("models"):
        dst_3d = os.path.join(lib, f"{lib}.3dshapes")
        os.makedirs(dst_3d, exist_ok=True)
        for fn in os.listdir(comp["models"]):
            shutil.copy(os.path.join(comp["models"], fn), dst_3d)

    update_paths(lib_sym, lib, dst_fp, dst_3d)
    update_footprint_3d_paths(dst_fp, dst_3d)
    print("→ Merge done.")

def create_library(comp):
    base    = os.path.splitext(comp["sym"])[0]
    default = base + LIB_SUFFIX
    name_in = input(f"Library name [{default}]: ").strip()
    name    = name_in or default
    if not name.endswith(LIB_SUFFIX):
        name += LIB_SUFFIX

    os.makedirs(name, exist_ok=True)
    dst_sym = os.path.join(name, f"{name}.kicad_sym")
    dst_fp  = os.path.join(name, f"{name}.pretty")
    shutil.move(comp["sym"], dst_sym)
    shutil.move(comp["pretty"], dst_fp)

    dst_models = None
    if comp.get("models"):
        dst_models = os.path.join(name, f"{name}.3dshapes")
        shutil.move(comp["models"], dst_models)

    update_paths(dst_sym, name, dst_fp, dst_models)
    update_footprint_3d_paths(dst_fp, dst_models)

    lib_desc = input(f"Library description [{name}]: ").strip() or name
    meta = {
      "$schema":"https://go.kicad.org/pcm/schemas/v1",
      "name": name, "description": lib_desc,
      "identifier": f"com.github.{GH_USER}.kicad-shared-libs.{name}",
      "type":"library", "license":"CC-BY-SA-4.0",
      "author":{"name":"Unknown"}, "maintainer":{"name":f"{GH_USER}"},
      "content":{
        "symbols":[f"{name}.kicad_sym"],
        "footprints":[f"{name}.pretty"],
        "3dmodels":([f"{name}.3dshapes"] if dst_models else [])
      },
      "versions":[{"version":"1.0.0","status":"stable","kicad_version":"9.0"}]
    }
    with open(os.path.join(name, "metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)

    repo_json = os.path.join(ROOT, "repository.json")
    if not os.path.isfile(repo_json):
        print("repository.json not found → creating new one")
        repo = {"packages": []}
    else:
        repo = json.load(open(repo_json))
    repo.setdefault("packages", []).append({"path": f"{name}/metadata.json"})
    open(repo_json, "w").write(json.dumps(repo, indent=2))
    print(f"→ Created library '{name}'.")

def cleanup_downloads(comp):
    print("Cleaning up…")
    if os.path.isfile(comp["sym"]):     os.remove(comp["sym"])
    if os.path.isdir(comp["pretty"]):   shutil.rmtree(comp["pretty"])
    if comp.get("models") and os.path.isdir(comp["models"]):
        shutil.rmtree(comp["models"])

def detect_kicad_installation():
    """Detect KiCad installation and return configuration paths."""
    kicad_configs = []
    
    # Check for Flatpak installation
    flatpak_config = os.path.expanduser("~/.var/app/org.kicad.KiCad/config/kicad")
    if os.path.isdir(flatpak_config):
        versions = [d for d in os.listdir(flatpak_config) if os.path.isdir(os.path.join(flatpak_config, d))]
        for version in sorted(versions, reverse=True):  # Latest version first
            version_path = os.path.join(flatpak_config, version)
            sym_table = os.path.join(version_path, "sym-lib-table")
            fp_table = os.path.join(version_path, "fp-lib-table")
            if os.path.isfile(sym_table) and os.path.isfile(fp_table):
                kicad_configs.append({
                    "type": "Flatpak",
                    "version": version,
                    "config_dir": version_path,
                    "sym_table": sym_table,
                    "fp_table": fp_table
                })
    
    # Check for regular installation
    regular_config = os.path.expanduser("~/.config/kicad")
    if os.path.isdir(regular_config):
        versions = [d for d in os.listdir(regular_config) if os.path.isdir(os.path.join(regular_config, d))]
        for version in sorted(versions, reverse=True):  # Latest version first
            version_path = os.path.join(regular_config, version)
            sym_table = os.path.join(version_path, "sym-lib-table")
            fp_table = os.path.join(version_path, "fp-lib-table")
            if os.path.isfile(sym_table) and os.path.isfile(fp_table):
                kicad_configs.append({
                    "type": "Regular",
                    "version": version,
                    "config_dir": version_path,
                    "sym_table": sym_table,
                    "fp_table": fp_table
                })
    
    return kicad_configs

def backup_library_table(table_path):
    """Create a backup of the library table file."""
    backup_path = table_path + ".backup"
    if not os.path.exists(backup_path):
        shutil.copy2(table_path, backup_path)
        print(f"→ Backup created: {backup_path}")
    return backup_path

def add_library_to_table(table_path, lib_name, lib_type, lib_uri, lib_desc=""):
    """Add a library entry to sym-lib-table or fp-lib-table."""
    backup_library_table(table_path)
    
    # Read current table
    with open(table_path, 'r') as f:
        lines = f.readlines()
    
    # Check if library already exists
    for line in lines:
        if f'(name "{lib_name}")' in line:
            print(f"→ Library '{lib_name}' already exists in {os.path.basename(table_path)}")
            return False
    
    # Find the closing parenthesis (last line)
    if lines and lines[-1].strip() == ")":
        # Insert new library entry before the closing parenthesis
        new_entry = f'  (lib (name "{lib_name}")(type "{lib_type}")(uri "{lib_uri}")(options "")(descr "{lib_desc}"))\n'
        lines.insert(-1, new_entry)
        
        # Write back to file
        with open(table_path, 'w') as f:
            f.writelines(lines)
        
        print(f"→ Added '{lib_name}' to {os.path.basename(table_path)}")
        return True
    else:
        print(f"→ Error: Malformed {os.path.basename(table_path)} file")
        return False

def install_libraries_to_kicad():
    """Install all local libraries to KiCad installation."""
    kicad_configs = detect_kicad_installation()
    
    if not kicad_configs:
        print("→ No KiCad installation detected.")
        return
    
    # Show detected installations
    print("\nDetected KiCad installations:")
    for i, config in enumerate(kicad_configs, 1):
        print(f" {i} - {config['type']} KiCad {config['version']} ({config['config_dir']})")
    
    # Get user choice
    if len(kicad_configs) == 1:
        choice = 1
        ans = input(f"Install libraries to {kicad_configs[0]['type']} KiCad {kicad_configs[0]['version']}? [Y/n]: ").lower()
        if ans and ans != "y":
            print("→ Installation cancelled.")
            return
    else:
        choice_input = input(f"Select installation [1]: ").strip()
        if not choice_input:
            choice = 1
        elif choice_input.isdigit():
            choice = int(choice_input)
        else:
            print("→ Invalid choice")
            return
    
    if choice < 1 or choice > len(kicad_configs):
        print("→ Invalid choice")
        return
    
    selected_config = kicad_configs[choice - 1]
    print(f"→ Installing to {selected_config['type']} KiCad {selected_config['version']}")
    
    # Find all local libraries
    libs = [
        d for d in os.listdir(ROOT)
        if os.path.isdir(os.path.join(ROOT, d))
        and os.path.isfile(os.path.join(ROOT, d, f"{d}.kicad_sym"))
    ]
    
    if not libs:
        print("→ No libraries found in current directory")
        return
    
    print(f"→ Found {len(libs)} libraries: {', '.join(libs)}")
    
    installed_count = 0
    
    for lib in libs:
        lib_path = os.path.join(ROOT, lib)
        
        # Add symbol library
        sym_uri = os.path.join(lib_path, f"{lib}.kicad_sym")
        sym_desc = f"Local library: {lib}"
        if add_library_to_table(selected_config['sym_table'], lib, "KiCad", sym_uri, sym_desc):
            installed_count += 1
        
        # Add footprint library if it exists
        fp_dir = os.path.join(lib_path, f"{lib}.pretty")
        if os.path.isdir(fp_dir):
            fp_desc = f"Local footprint library: {lib}"
            add_library_to_table(selected_config['fp_table'], lib, "KiCad", fp_dir, fp_desc)
    
    print(f"→ Installation complete! Added {installed_count} libraries to KiCad.")
    print("→ Restart KiCad to see the new libraries.")

def package_repo():
    out = os.path.basename(ROOT) + ".zip"
    print(f"Zipping repo → {out}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for dp, _, fns in os.walk(ROOT):
            if ".git" in dp: continue
            for fn in fns:
                if fn.endswith((".pyc","~")): continue
                p = os.path.join(dp, fn)
                zf.write(p, os.path.relpath(p, ROOT))
    print("→ Done.")

def main():
    # Check if user wants to install libraries to KiCad
    if len(sys.argv) > 1 and sys.argv[1] == "install":
        install_libraries_to_kicad()
        return
    
    # Show menu if no components found
    comp = find_local_component()
    if not comp:
        print("\nNo local components found. Choose an option:")
        print(" 1 - Download JLCPCB parts and create library")
        print(" 2 - Install existing libraries to KiCad")
        choice = input("Select [1]: ").strip()
        
        if choice == "2":
            install_libraries_to_kicad()
            return
        elif choice == "" or choice == "1":
            parts = input("Enter JLCPCB part#s: ").split()
            if not parts:
                sys.exit("No parts specified.")
            run_jlc(parts)
            wrap_assets()
            comp = find_local_component()
            if not comp:
                sys.exit("Error: no component.")
        else:
            sys.exit("Invalid choice.")
    
    # Process component
    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])
    check_duplicate(comp)
    lib = choose_library()
    if lib:
        merge_into(lib, comp)
    else:
        create_library(comp)
    cleanup_downloads(comp)
    
    # Ask about additional actions
    print("\nAdditional actions:")
    if input("Install libraries to KiCad? [y/N]: ").lower() == "y":
        install_libraries_to_kicad()
    if input("Create GitHub-release zip now? [y/N]: ").lower() == "y":
        package_repo()

if __name__ == "__main__":
    main()
