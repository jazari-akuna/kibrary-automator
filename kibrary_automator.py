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
    comp = find_local_component()
    if not comp:
        parts = input("Multiple/no components found. Enter JLCPCB part#s: ").split()
        run_jlc(parts)
        wrap_assets()
        comp = find_local_component()
        if not comp:
            sys.exit("Error: no component.")
    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])
    check_duplicate(comp)
    lib = choose_library()
    if lib:
        merge_into(lib, comp)
    else:
        create_library(comp)
    cleanup_downloads(comp)
    if input("Create GitHub-release zip now? [y/N]: ").lower() == "y":
        package_repo()

if __name__ == "__main__":
    main()
