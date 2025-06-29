#!/usr/bin/env python3
import os, sys, shutil, json, zipfile, subprocess, re

ROOT    = os.getcwd()
LIB_SUFFIX = "_KSL"   # change this if you need a different suffix

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
    open(sym_file,"w").write(t)

def set_default_designator(sym_file):
    lines = open(sym_file).read().splitlines()
    cur = next((m.group(1) for ln in lines
               if (m:=re.match(r'\s*\(property\s+"Reference"\s+"([^"]+)"',ln))), "")
    ans = input(f"Default reference [{cur}]: ").strip().upper()
    new = (ans or cur)
    if new and not new.endswith("?"): new += "?"
    out = []
    for ln in lines:
        if '(property "Reference"' in ln:
            ln = re.sub(r'\(property\s+"Reference"\s+"[^"]+"',
                        f'(property "Reference" "{new}"', ln)
        out.append(ln)
    open(sym_file,"w").write("\n".join(out)+"\n")
    print(f"→ Reference set to {new}")

def find_local_component():
    syms  = [f for f in os.listdir(".") if f.endswith(".kicad_sym")]
    prets = [d for d in os.listdir(".") if d.endswith(".pretty")]
    if len(syms)==1 and len(prets)==1:
        comp = {"sym": syms[0], "pretty": prets[0]}
        models = [d for d in os.listdir(".") if d.endswith(".3dshapes")]
        if models: comp["models"] = models[0]
        return comp
    return None

def edit_symbol_description(sym_file):
    pass  # optional $EDITOR hook

def check_duplicate(comp):
    # get new symbol name
    lines = open(comp["sym"]).read().splitlines()
    name = next((re.match(r'\(symbol\s+"([^"]+)"',ln.lstrip()).group(1)
                 for ln in lines if ln.lstrip().startswith("(symbol ")), None)
    if not name: return
    for lib in os.listdir(ROOT):
        lib_sym = os.path.join(ROOT,lib, f"{lib}.kicad_sym")
        if os.path.isfile(lib_sym):
            if f'(symbol "{name}"' in open(lib_sym).read():
                ans = input(f"Component {name} exists in '{lib}'. Add anyway? [y/N]: ").lower()
                if ans != "y":
                    print("→ Aborting add.")
                    cleanup_downloads(comp)
                    sys.exit(0)
                return

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
    lib_sym = os.path.join(lib, f"{lib}.kicad_sym")
    lines   = open(lib_sym).read().splitlines()
    if lines[-1].strip() != ")":
        sys.exit(f"Bad format in {lib_sym}")
    header = lines[:-1]
    new    = open(comp["sym"]).read().splitlines()
    start  = next(i for i,ln in enumerate(new) if ln.lstrip().startswith("(symbol "))
    inner  = new[start:-1]
    merged = header + [""] + ["  "+ln for ln in inner] + [")"]
    open(lib_sym,"w").write("\n".join(merged)+"\n")
    dst_fp = os.path.join(lib, f"{lib}.pretty")
    for fn in os.listdir(comp["pretty"]):
        if fn.endswith(".kicad_mod"):
            shutil.copy(os.path.join(comp["pretty"],fn), dst_fp)
    dst_3d = None
    if comp.get("models"):
        dst_3d = os.path.join(lib, f"{lib}.3dshapes")
        os.makedirs(dst_3d, exist_ok=True)
        for fn in os.listdir(comp["models"]):
            shutil.copy(os.path.join(comp["models"],fn), dst_3d)
    update_paths(lib_sym, lib, dst_fp, dst_3d)
    print("→ Merge done.")

def create_library(comp):
    base = os.path.splitext(comp["sym"])[0]
    default = base + LIB_SUFFIX
    name_in = input(f"Library name [{default}]: ").strip()
    name = name_in or default
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
    desc = input(f"Component description [{name}]: ").strip() or name
    meta = {
      "$schema":"https://go.kicad.org/pcm/schemas/v1",
      "name": name, "description": desc,
      "identifier": f"com.github.YOURGHUSER.kicad-shared-libs.{name}",
      "type":"library", "license":"CC-BY-SA-4.0",
      "author":{"name":"Unknown"}, "maintainer":{"name":"YOURGHUSER"},
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
        repo = {"packages":[]}
    else:
        repo = json.load(open(repo_json))
    repo.setdefault("packages",[]).append({"path":f"{name}/metadata.json"})
    open(repo_json,"w").write(json.dumps(repo, indent=2))
    print(f"→ Created library '{name}'.")

def cleanup_downloads(comp):
    print("Cleaning up…")
    if os.path.isfile(comp["sym"]):   os.remove(comp["sym"])
    if os.path.isdir(comp["pretty"]): shutil.rmtree(comp["pretty"])
    if comp.get("models") and os.path.isdir(comp["models"]):
        shutil.rmtree(comp["models"])

def package_repo():
    out = os.path.basename(ROOT)+".zip"
    print(f"Zipping repo → {out}")
    with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as zf:
        for dp,_,fns in os.walk(ROOT):
            if ".git" in dp: continue
            for fn in fns:
                if fn.endswith((".pyc","~")): continue
                p = os.path.join(dp,fn)
                zf.write(p, os.path.relpath(p,ROOT))
    print("→ Done.")

def main():
    comp = find_local_component()
    if not comp:
        parts = input("Multiple/no components found. Enter JLCPCB part#s: ").split()
        run_jlc(parts); wrap_assets()
        comp = find_local_component()
        if not comp: sys.exit("Error: no component.")
    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])
    check_duplicate(comp)
    lib = choose_library()
    if lib:
        merge_into(lib, comp)
    else:
        create_library(comp)
    cleanup_downloads(comp)
    if input("Create GitHub-release zip now? [y/N]: ").lower()=="y":
        package_repo()

if __name__=="__main__":
    main()

