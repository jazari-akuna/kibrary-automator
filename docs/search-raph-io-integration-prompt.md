# Prompt for Claude: Implement the Kibrary integration on the search.raph.io side

Paste everything below into a fresh Claude session **whose working directory is the `jlc-search` repository** (`/root/jlc-search` on this server, public name `search.raph.io`). Don't paste it in the kibrary repo — that side is already done.

---

## Context

You are working in the `jlc-search` repo (also known publicly as `search.raph.io` / `search.the-chipyard.com`). This is a Bun + Hono backend with PostgreSQL indexing 3.5M+ JLCPCB/LCSC parts. See the project's own `CLAUDE.md` and `README.md` for the existing architecture.

A new desktop client called **Kibrary** (`https://github.com/jazari-akuna/kibrary-automator`, repo also at `/root/kibrary-automator` on this server) has just shipped its v26.4.26-alpha.1 release. Kibrary already has the **client-side** integration written and waiting:

- A search panel block in the Add room (`src/blocks/SearchPanel.tsx`)
- A Python sidecar `search_client.py` that calls the API with `Authorization: Bearer <api-key>`
- API key stored in the user's OS keychain (Keychain / Credential Manager / libsecret)
- Three endpoints called: `GET /api/search`, `GET /api/parts/:lcsc`, `GET /api/parts/:lcsc/photo`

What Kibrary expects from the API is documented in:
- `/root/kibrary-automator/docs/superpowers/specs/2026-04-25-kibrary-redesign.md` §8 (search.raph.io integration)
- `/root/kibrary-automator/sidecar/kibrary_sidecar/search_client.py` (the actual call sites + expected response shapes)

Read those two files first.

## Goal

Make sure the three currently-called endpoints work end-to-end against `jlc-search`, and add a small auth + access-control layer so that **only Kibrary clients with a valid API key can call them** (the user wants to discourage scraping outside the app). Then add ONE small new endpoint the Kibrary spec calls for: `GET /api/parts/batch` (so a queue of N LCSCs is one round-trip instead of N).

Five concrete deliverables:

### 1. API key issuing flow

Add a way for the maintainer to mint API keys for the Kibrary client. Simplest viable path:

- A `kibrary_api_keys` table: `id`, `key_hash` (argon2 or bcrypt of the raw key), `label`, `created_at`, `last_used_at`, `revoked_at`.
- A small admin CLI script `scripts/issue-kibrary-key.ts` that:
  - Generates a 32-byte URL-safe random key
  - Prints it ONCE to stdout (so it can be copied into Kibrary's Settings room which writes it to the OS keychain)
  - Stores only the hash in the DB

Don't build a full admin UI. The CLI is enough.

### 2. Bearer-auth middleware

Add a Hono middleware that:
- Reads `Authorization: Bearer <key>` from the request
- Hashes the incoming key, looks it up in `kibrary_api_keys` where `revoked_at IS NULL`
- On match: updates `last_used_at`, lets the request through
- On miss: returns 401 with a helpful message
- Apply this middleware to a new `/api/kibrary/*` route prefix (so the existing public-facing search UI keeps working without auth)

### 3. Mirror the three endpoints under `/api/kibrary`

Re-expose the three endpoints Kibrary calls, behind the auth middleware:

| Existing public route | New auth-gated route | Response shape Kibrary expects |
|---|---|---|
| `GET /api/search?q=<query>` | `GET /api/kibrary/search?q=<query>` | `{ results: [{ lcsc, mpn, description, photo_url?, in_stock }] }` |
| `GET /api/parts/:lcsc` | `GET /api/kibrary/parts/:lcsc` | The full part metadata dict (whatever the existing endpoint returns is fine — Kibrary uses `category` and `subcategory` from this) |
| `GET /api/parts/:lcsc/photo` | `GET /api/kibrary/parts/:lcsc/photo` | The image binary, same `Content-Type` as the public endpoint |

Confirm by `curl`-testing each with a freshly minted key.

### 4. Add the batch endpoint

Add a NEW endpoint not present today:

```
GET /api/kibrary/parts/batch?lcsc=C1525,C25804,C12345
```

Response:
```json
{
  "parts": {
    "C1525":  { ...same shape as /api/parts/:lcsc... },
    "C25804": { ...same... },
    "C12345": null
  }
}
```

`null` for any LCSC that doesn't exist. Cap the batch at 100 LCSCs (return 400 if exceeded). One DB round-trip via `WHERE lcsc IN (...)`.

### 5. Rate-limiting (best-effort)

Per-key rate limit: e.g. 60 requests / minute / key for `/search`, 600 requests / minute / key for `/parts/:lcsc`. Use a tiny in-memory token bucket (Hono has middleware for this) — no Redis required for an alpha. Returns 429 on overflow.

## Test plan

Add a `tests/kibrary-integration.test.ts` that:

1. Mints a test key via the CLI (use a fixture DB)
2. Calls `/api/kibrary/search?q=10k+0402` → expects results array
3. Calls `/api/kibrary/parts/C25804` → expects a part object with `category`
4. Calls `/api/kibrary/parts/batch?lcsc=C1525,C25804,Cnonexistent` → expects 3 keys, third is null
5. Calls without `Authorization` header → expects 401
6. Calls with a revoked key → expects 401
7. Hammer the search endpoint past the rate limit → expects 429

## Constraints

- Don't change the existing `/api/search`, `/api/parts/:lcsc`, `/api/parts/:lcsc/photo` endpoints — they power the public-facing search UI and removing them would break the live site at search.the-chipyard.com.
- Reuse the existing search/SQL logic; the new `/api/kibrary/*` routes are thin wrappers that add auth + maybe response-shape tweaks.
- Don't commit any real API keys. The CLI prints to stdout, never writes a key to disk except as a hash in the DB.

## When done

1. Issue ONE API key via your new CLI
2. Print it to the user (they will paste it into Kibrary's Settings room)
3. Document the new endpoints in `README.md` and `CLAUDE.md`
4. Open a draft PR against the main branch summarizing the change (don't push directly to main)

That's it. Total scope: ~one focused dev session.

---

## Notes for the user (raph)

**Receiving the API key** — when the search.raph.io session prints a key, paste it into:

- **Production**: open Kibrary, go to the Settings room, paste it into the search.raph.io API key field. It writes to the OS keychain (Keychain / Credential Manager / libsecret), never to a config file. Verified by inspecting `~/.config/kibrary/settings.json` — should NOT contain the key.

- **Dev / this server**: if you want me to test from inside the kibrary venv, paste the key in this session and I'll set it via:
  ```
  python3 -c "import keyring; keyring.set_password('kibrary', 'search_raph_io_api_key', '<KEY>')"
  ```
  (Run from this server's terminal, NOT in the Claude transcript — better, pipe via `keyring set` interactively so the value never appears in scrollback.)

I'll never need the *contents* of the private key visible in this transcript — just the confirmation that it was set.
