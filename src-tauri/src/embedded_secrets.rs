//! Compile-time-baked secrets, XOR-deobfuscated at runtime.
//!
//! See `build.rs` for the obfuscation step. The embedded blob lives in
//! `OUT_DIR/search_api_key.bin` and is included via `include_bytes!`.
//! `EMBED_MASK` must mirror the build-time mask.

const EMBED_MASK: [u8; 32] = [
    0x9e, 0x4c, 0xa1, 0x33, 0x77, 0xd1, 0x52, 0x08, 0xb6, 0x2f, 0xee, 0x14,
    0x8b, 0x6a, 0xc7, 0x39, 0x05, 0xfd, 0x91, 0x4d, 0x28, 0xb3, 0x76, 0x1c,
    0xa0, 0x68, 0xdb, 0x47, 0xf2, 0x59, 0x82, 0x3a,
];

const OBF_KEY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/search_api_key.bin"));

/// Returns the search.raph.io API key baked into the binary at build time.
/// Empty if the build was performed without `KIBRARY_SEARCH_API_KEY` set —
/// in that case the search panel renders nothing.
pub fn search_api_key() -> String {
    let bytes: Vec<u8> = OBF_KEY
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ EMBED_MASK[i % EMBED_MASK.len()])
        .collect();
    String::from_utf8(bytes).unwrap_or_default()
}
