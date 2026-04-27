use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // ----- Embed search.raph.io API key, XOR-obfuscated. ---------------------
    //
    // Reads KIBRARY_SEARCH_API_KEY from the build environment. The raw key is
    // never written verbatim into the binary — we XOR it against EMBED_MASK so
    // `strings <binary>` doesn't surface it. Anyone with a debugger can still
    // recover it (this is a desktop app — perfect concealment isn't possible),
    // but it raises the bar enough that casual extraction fails.
    //
    // If the env var is missing the build still succeeds and the embedded key
    // is empty — the app behaves as if no search subscription is configured.
    println!("cargo:rerun-if-env-changed=KIBRARY_SEARCH_API_KEY");

    let key = env::var("KIBRARY_SEARCH_API_KEY").unwrap_or_default();
    let mut obf = Vec::with_capacity(key.len());
    for (i, b) in key.as_bytes().iter().enumerate() {
        obf.push(b ^ EMBED_MASK[i % EMBED_MASK.len()]);
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("search_api_key.bin"), &obf)
        .expect("write embedded search api key blob");
}

// 32 bytes of mask material. Anything constant works — the whole point is
// to make the cleartext disappear from `strings`. Chosen to be visually
// noisy bytes so the obfuscated blob doesn't look like ASCII either.
const EMBED_MASK: [u8; 32] = [
    0x9e, 0x4c, 0xa1, 0x33, 0x77, 0xd1, 0x52, 0x08, 0xb6, 0x2f, 0xee, 0x14,
    0x8b, 0x6a, 0xc7, 0x39, 0x05, 0xfd, 0x91, 0x4d, 0x28, 0xb3, 0x76, 0x1c,
    0xa0, 0x68, 0xdb, 0x47, 0xf2, 0x59, 0x82, 0x3a,
];
