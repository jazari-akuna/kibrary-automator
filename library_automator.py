#!/usr/bin/env python3
import os
import sys
import shutil
import json
import zipfile
import subprocess
import re

# use current working directory as repo root
ROOT = os.getcwd()

def run_jlc(parts):
    cmd = ["JLC2KiCadLib"] + parts + [
        "-dir", ".", "-symbol_lib_dir", ".", "-footprint_lib", ".", "-model_dir", "."
    ]
    subprocess.check_call(cmd)

def wrap_assets():
    for fn in os.listdir("."):
        if fn.endswith(".kicad_mod"):
            base = fn.rsplit(".",1)[0]
            d = f"{base}.pretty"
            os.makedirs(d, exist_ok=True)
            shutil.move(fn, os.path.join(d, fn))
        if fn.lower().endswith((".wrl", ".step", ".stp", ".3ds")):
            base = fn.rsplit(".",1)[0]
            d = f"{base}.3dshapes"
            os.makedirs(d, exist_ok=True)
            shutil.move(fn, os.path.join(d, fn))

def update_paths(sym_file, lib_name, fp_dir, model_dir):
    text = open(sym_file).read()
    text = text.replace('".:', f'"{lib_name}:')
    text = text.replace('".', f'"{lib_name}:')
    if model_dir:
        base3d = os.path.basename(model_dir)
        text = text.replace('3dshapes/', f'{base3d}/')
    with open(sym_file, "w") as f:
        f.write(text)

def set_default_designator(sym_file):
    # extract current Reference
    lines = open(sym_file).read().splitlines()
    cur = None
    for ln in lines:
        m = re.match(r'\s*\(property\s+"Reference"\s+"([^"]+)"', ln)
        if m:
            cur = m.group(1)
            break
    cur = cur or ""
    ans = input(f"Default reference [{cur}]: ").strip().upper()
    new = ans if ans else cur
    if not new.endswith("?"):
        new += "?"
    # rewrite file
    out = []
    for ln in lines:
        if '(property "Reference"' in ln:
            ln = re.sub(r'\(property\s+"Reference"\s+"[^"]+"',
                        f'(property "Reference" "{new}"', ln)
        out.append(ln)
    with open(sym_file, "w") as f:
        f.write("\n".join(out)+"\n")
    print(f"→ Reference set to {new}")

def find_local_component():
    syms = [f for f in os.listdir(".") if f.endswith(".kicad_sym")]
    prets = [d for d in os.listdir(".") if d.endswith(".pretty")]
    if len(syms)==1 and len(prets)==1:
        comp = {"sym": syms[0], "pretty": prets[0]}
        models = [d for d in os.listdir(".") if d.endswith(".3dshapes")]
        if models: comp["models"] = models[0]
        return comp
    return None

def edit_symbol_description(sym_file):
    # stub: you can launch $EDITOR here if desired
    pass

def choose_library():
    libs = [d for d in os.listdir(ROOT)
            if os.path.isdir(os.path.join(ROOT,d))
            and os.path.isfile(os.path.join(ROOT,d, f"{d}.kicad_sym"))]
    if not libs:
        return None
    print("Existing libraries:")
    for i,l in enumerate(libs,1):
        print(f" {i}) {l}")
    sel = input("Merge into which? [enter to make new]: ").strip()
    if sel.isdigit() and 1 <= int(sel) <= len(libs):
        return libs[int(sel)-1]
    return None

def merge_into(lib, comp):
    print(f"Merging '{comp['sym']}' into '{lib}'")
    lib_sym = os.path.join(lib, lib+".kicad_sym")

    lines = open(lib_sym).read().splitlines()
    if lines[-1].strip() != ')':
        sys.exit(f"Unexpected format in {lib_sym}")
    header = lines[:-1]

    new = open(comp["sym"]).read().splitlines()
    start = next(i for i,ln in enumerate(new) if ln.lstrip().startswith('(symbol '))
    inner = new[start:-1]

    merged = header + [''] + ['  '+ln for ln in inner] + [')']
    with open(lib_sym, 'w') as f:
        f.write("\n".join(merged)+"\n")
    print("→ Symbols merged.")

    dst_fp = os.path.join(lib, lib+".pretty")
    for fn in os.listdir(comp["pretty"]):
        if fn.endswith(".kicad_mod"):
            shutil.copy(os.path.join(comp["pretty"], fn), dst_fp)

    if comp.get("models"):
        dst_3d = os.path.join(lib, lib+".3dshapes")
        os.makedirs(dst_3d, exist_ok=True)
        for fn in os.listdir(comp["models"]):
            shutil.copy(os.path.join(comp["models"], fn), dst_3d)
    else:
        dst_3d = None

    update_paths(lib_sym, lib, dst_fp, dst_3d)
    print("→ Merge done.")

def create_library(comp):
    name = os.path.splitext(comp["sym"])[0]
    os.makedirs(name, exist_ok=True)
    dst_sym   = os.path.join(name, f"{name}.kicad_sym")
    dst_fpdir = os.path.join(name, f"{name}.pretty")
    shutil.move(comp["sym"], dst_sym)
    shutil.move(comp["pretty"], dst_fpdir)
    dst_models = None
    if comp.get("models"):
        dst_models = os.path.join(name, f"{name}.3dshapes")
        shutil.move(comp["models"], dst_models)

    update_paths(dst_sym, name, dst_fpdir, dst_models)

    desc = input(f"Library description [{name}]: ").strip() or name
    meta = {
      "$schema":"https://go.kicad.org/pcm/schemas/v1",
      "name": name,
      "description": desc,
      "identifier": f"com.github.YOURGHUSER.kicad-shared-libs.{name}",
      "type":"library",
      "license":"CC-BY-SA-4.0",
      "author":{"name":"Unknown"},
      "maintainer":{"name":"YOURGHUSER"},
      "content":{
        "symbols":[f"{name}.kicad_sym"],
        "footprints":[f"{name}.pretty"],
        "3dmodels":([f"{name}.3dshapes"] if dst_models else [])
      },
      "versions":[{"version":"1.0.0","status":"stable","kicad_version":"9.0"}]
    }
    with open(os.path.join(name,"metadata.json"),"w") as f:
        json.dump(meta, f, indent=2)

    repo_json = os.path.join(ROOT, "repository.json")
    if not os.path.isfile(repo_json):
        print("repository.json not found → creating new one")
        repo = {"packages": []}
    else:
        repo = json.load(open(repo_json))

    repo.setdefault("packages",[]).append({"path":f"{name}/metadata.json"})
    with open(repo_json, "w") as f:
        json.dump(repo, f, indent=2)

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
        for dp,_,fns in os.walk(ROOT):
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
            sys.exit("Error: Failed to generate or detect a component.")

    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])

    lib = choose_library()
    if lib:
        merge_into(lib, comp)
    else:
        create_library(comp)

    cleanup_downloads(comp)

    if input("Create GitHub-release zip now? [y/N]: ").lower()=="y":
        package_repo()

if __name__ == "__main__":
    main()
