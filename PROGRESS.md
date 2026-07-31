# Progress Log — Extraction Review Pipeline

## Phase 0 — Scaffold

### Summary
Monorepo scaffold (`/api` Fastify + Drizzle + `/health`, `/web` Vite+React+Tailwind placeholder), infrastructure provisioned on Railway + Supabase, `.env.example`, and this file. No business logic yet — `extraction_schemas`/`batches`/`documents`/etc. tables and all ingest/extract/confidence/review/export/eval code are Phase 1+.

### Files created/touched
- Root: `package.json` (npm workspaces `api`+`web`), `tsconfig.base.json`, `.env.example`, `.env` (gitignored, not committed), `PROGRESS.md`.
- `/api`: `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `src/{app,index}.ts`, `src/db/{client,schema}.ts` (+`migrations/.gitkeep`), `src/routes/health.ts`, `src/lib/{env,logger,storage,anthropic}.ts`, `src/{ingest,extract,confidence,review,export,eval}/.gitkeep`, `test/health.test.ts`.
- `/web`: Vite React-TS scaffold (`npm create vite@latest web -- --template react-ts`), Tailwind v4 wired via `@tailwindcss/vite`, default demo content stripped from `App.tsx`/`main.tsx`, `src/styles/index.css` (`@import "tailwindcss";`), `.gitkeep` placeholders for `src/pages`, `src/components/{DocViewer,ReviewPane}`.
- `/docs`, `/scripts`, `/samples`: `.gitkeep` only — real content is later phases (docs: Phase 9; scripts/samples: Phase 1).

### Infrastructure provisioned
- **Railway:** Postgres deployed via the official `postgres` template (image `postgres-ssl:18`) as service **`Postgres-ERP`** inside the existing **"Upwork Portfolio"** project (id `f5549c0c-4269-4f60-a1dd-f12e6543ffc8`, env `production` id `6be5b32b-e74e-4d9a-b027-bc406b715688`), service id `2865a13c-bc05-4d34-ab49-8599363478d7`. Deployment status `SUCCESS`.
  - *Note:* a standalone `Extraction-Review-Pipeline` Railway project was created first (per the original isolation plan), but the user asked mid-build to place the DB under "Upwork Portfolio" instead — the standalone project (and its now-orphaned Postgres service) was deleted, and `Postgres-ERP` was deployed directly into "Upwork Portfolio" as a **dedicated** service (not reusing the predecessor's existing `Postgres`/`Postgres-zrMR` services, to keep data isolated even though the Railway project is now shared).
- **Supabase:** bucket **`erp-documents`** created in the existing "Upwork Portfolio" Supabase project (ref `vujkdmnvegfvtvxpyebw`), `public: false`, 20MB file size limit, allowed types `application/pdf`/`image/png`/`image/jpeg`. Named `erp-documents` (not the spec's literal `documents`) because that project already has a `documents` bucket owned by the predecessor `Document-Data-Extractor` repo.

### Decisions
- Bucket renamed from the spec's literal `documents` to `erp-documents` — confirmed with the user (name collision with the predecessor's bucket in the same shared Supabase project).
- **Bucket creation went through `supabase_execute_sql` (direct SQL insert into `storage.buckets`), not the Management API** — `POST /v1/projects/{ref}/storage/buckets` 404'd (the tool's dedicated bucket-create path doesn't exist server-side); the SQL fallback anticipated in the plan was used instead and verified via a follow-up `GET`.
- **This sandbox's network egress policy blocks direct outbound access to `*.supabase.co` (HTTPS) and to Railway's public Postgres TCP proxy** (raw TCP) — confirmed directly, and confirmed again by actually booting the real server with real `.env` values: `GET /health` returned `503` with `db.error: "Connection terminated due to connection timeout"` and `storage.error: "HTTP 403: Host not in allowlist: vujkdmnvegfvtvxpyebw.supabase.co. Add this host to your network egress settings to allow access."` — an explicit egress-allowlist rejection, not a credentials or code problem. `api.anthropic.com`, by contrast, **is** reachable from this sandbox: once the real `ANTHROPIC_API_KEY` was added, `anthropic.ok` came back `true` with `model: "claude-sonnet-5"` for real. So 1 of 3 checks is now genuinely verified end-to-end; **db and storage still need a real `/health` hit from a machine with normal internet egress** (per rule 10, the Windows dev machine) to confirm.
- Local `DATABASE_URL` uses Railway's `DATABASE_PUBLIC_URL` value, not the private-network `DATABASE_URL` the template also exposes — the private one resolves through `RAILWAY_PRIVATE_DOMAIN`, unreachable from outside Railway's own network.
- `pg.Pool` configured with `ssl: { rejectUnauthorized: false }` — the `postgres-ssl` template image serves a self-signed certificate.
- No `@supabase/supabase-js` dependency added — `api/src/lib/storage.ts` uses Node 20's built-in `fetch` against the Storage REST API directly (a single GET is all Phase 0 needs). Revisit when Phase 2 wants richer upload helpers.
- Tailwind v4 (`@tailwindcss/vite`, CSS-first `@import "tailwindcss";`) for `/web`, not v3/postcss.
- `api/src/db/schema.ts` is intentionally `export {}` — real tables are Phase 1.
- `@anthropic-ai/sdk` bumped from the initially-planned `^0.32.0` to `^0.115.0` — `client.models.retrieve()` (used by `pingAnthropic`) doesn't exist on 0.32.x; this is a version fix within the already-approved dependency, not a new one.
- Added a 5s `connectionTimeoutMillis` on the `pg.Pool` and a 5s `AbortSignal.timeout` on the storage fetch — confirmed while testing locally (see below) that an unreachable DB/storage host would otherwise hang `/health` indefinitely instead of reporting `degraded` promptly.

### Open questions
- **`EXTRACTION_TEMPERATURE=0.8` cannot be sent as a literal `temperature` request parameter to `claude-sonnet-5`** — verified directly against Anthropic's current API docs: current-generation models reject any non-default `temperature`/`top_p`/`top_k` with an HTTP 400. Omitting the parameter still yields real sampling diversity (the implicit default), so the Phase 3 confidence-scoring design (§5.2, sample agreement) is salvageable, but the extraction runner must never forward `temperature` on `messages.create()`. **Resolve the exact approach (drop the parameter but keep recording the configured value on the `extractions` row for audit purposes? Something else?) before starting Phase 3.**
- Exact npm package versions are whatever `npm install` resolves within the ranges pinned in `package.json`; see the generated lockfile once installed.

### Checkpoint — ALL ITEMS CONFIRMED (2026-07-31)
- [x] Supabase bucket `erp-documents` confirmed reachable — live `GET /health` from the user's machine returned `storage: {"ok": true, "bucket": "erp-documents"}`.
- [x] Railway Postgres (`Postgres-ERP` in "Upwork Portfolio") confirmed reachable — the user ran `npm run db:migrate --workspace api` from their own (Windows) machine, which connected and applied the migration; independently re-verified twice: a direct `pg_tables` query (all 12 tables present) and live `GET /health` returning `db: {"ok": true, "latencyMs": 1435}`.
- [x] Anthropic API key confirmed working — live `GET /health` returns `anthropic: {"ok": true, "model": "claude-sonnet-5"}`. Credit + spend limit confirmed set in-console by the user (2026-07-30).
- Final confirming `/health` response (user's machine, 2026-07-31): `{"status":"ok","checks":{"db":{"ok":true,"latencyMs":1435},"storage":{"ok":true,"bucket":"erp-documents"},"anthropic":{"ok":true,"model":"claude-sonnet-5"}}}`.

## Phase 1 — Schema + synthetic corpus

### Summary
Full Drizzle schema for all 12 tables from the spec, a generated (but not yet applied — see below) migration, and a 60-document synthetic corpus with a ground-truth manifest for later gold-set seeding.

### Files created/touched
- `api/src/db/schema.ts` — all 12 tables: `extraction_schemas`, `batches`, `documents`, `pages`, `extractions`, `field_values`, `field_value_rows`, `corrections`, `review_sessions`, `exports`, `gold_set_items`, `accuracy_snapshots`.
- `api/src/db/migrations/0000_mushy_scourge.sql` — generated via `drizzle-kit generate` (schema-diff only; does not require a live DB connection).
- `scripts/fieldSpecs.ts` — field/column specs for `invoice`/`receipt`/`purchase_order`, mirroring the `extraction_schemas.fields` jsonb shape; shared between the generator now and real schema seeding later.
- `scripts/make-synthetic-docs.ts` — generates the 60-document corpus into `/samples` (run via `npm run gen:samples`).
- `/samples/*.pdf` (60 files) + `/samples/manifest.json` (ground-truth ledger) — generated output, committed.
- `README.md` — added a "Synthetic data" section per rule 7.

### Corpus composition (verified)
- 60 PDFs: 15 clean digital, 15 scanned/skewed, 15 multi-page line-item tables, 15 edge cases — 20 invoices / 20 receipts / 20 purchase orders (evenly distributed within each difficulty group).
- 10 flagged `inDevSubset: true` in the manifest, spanning all four difficulty groups (3 clean, 3 scanned, 2 multipage, 2 edge_case).
- Edge cases cycle through all four kinds named in the spec: handwriting-in-one-field (rendered as a rasterized italic snippet embedded as an image, not text), two-currencies (one line item printed in € while the header currency says USD), missing-required-field (a required field omitted entirely — `null` in the manifest), and near-duplicate-vendor-name (e.g. "Blackwood Supply Co." vs "Blackwood Supply Co, Inc.").
- **Verified with `pdfjs-dist`** (temporarily installed with `--no-save` for this check only — not a project dependency yet): a clean doc's text layer extracts all field values (468 chars); a scanned doc's text layer extracts **zero** characters (confirming it's genuinely image-only); the handwriting edge-case doc's text layer contains every field's label and value **except** the one rendered as an image. A multi-page doc's page count is verified as 2 via `pdf-lib`.

### Decisions
- **PDF-authoring library: `pdf-lib`** (root `dependencies`, alongside `@napi-rs/canvas` for the scanned/handwriting raster rendering) — approved by the user; `pdfjs-dist` (already in the approved stack) only reads/rasterizes existing PDFs, it can't author new ones.
- `scripts/*.ts` are not an npm workspace (per the repo layout, `/scripts` is a sibling of `/api`/`/web`, not a member) — their dependencies (`pdf-lib`, `@napi-rs/canvas`, `tsx`) live in the **root** `package.json` instead, resolved via Node's normal upward `node_modules` lookup.
- `drizzle-kit` bumped `^0.28.0` → `^0.31.0` — 0.28.1's config loader broke with `"require is not defined in ES module scope"` under `"type": "module"` + Node 22; the newer version loads cleanly. Same category of fix as the `@anthropic-ai/sdk` bump in Phase 0 (correcting an initial version pin within an already-approved dependency).
- **The migration has been applied to the live Railway Postgres** — done from the user's own machine (this sandbox still can't reach `sakura.proxy.rlwy.net`, confirmed in Phase 0). All 12 tables verified present via a direct `pg_tables` query (2026-07-31).
- **`api/drizzle.config.ts` env-loading hardened during this troubleshooting**: the user's first `db:migrate` attempt failed with `url: undefined` because no `.env` existed at the repo root at all (only `.env.example` — the first file-send attempt never got placed there). Fixed the config to try multiple candidate `.env` locations (`import.meta.url`-relative and `process.cwd()`-relative) instead of exactly one, and to throw a clear error naming every path it tried if `DATABASE_URL` still isn't found, instead of a bare `undefined`.
- Note: `drizzle-kit migrate` on this version (`^0.31.0`) prints no success banner on completion — silence after `Using 'pg' driver for database querying` is normal, not a failure. Verify success by querying the DB directly (as done here) rather than expecting console output.
- **Important gotcha discovered — secrets pasted from chat text can get silently corrupted.** To unblock the missing `.env`, the user was given a `cat > .env << 'EOF' ... EOF` heredoc containing the real secrets as inline chat text to paste into git-bash. This got `DATABASE_URL` working (`db.ok` went `true`), but `storage` and `anthropic` then failed with a Node `ByteString`/`fetch` header error citing a character with code `8226` — Unicode `•` (bullet). A diagnostic script scanning the `.env` for any character above code 255 showed the **entire tail** of both `SUPABASE_SERVICE_KEY` (after `eyJhbGci...`) and `ANTHROPIC_API_KEY` (after `sk-ant-a...`) had been replaced with bullet characters. Root cause: something in the chat rendering/copy pipeline appears to display-redact text that pattern-matches a secret (recognizable prefix + long token) when it's rendered as copyable markdown, so copy-pasting a secret out of chat text is **not reliable** — the Railway Postgres URL wasn't redacted (doesn't match a "secret" pattern), but the JWT and the Anthropic key were. **Fix: deliver secrets only via a real file attachment (the `SendUserFile` tool), never as inline chat/code-block text.** Re-sent `.env` as an attachment; the user found it in `~/Downloads` saved as bare `env` (the browser stripped the leading dot — a separate, secondary Windows/browser quirk), moved it into place with `mv`, and it verified clean. `GET /health` then returned all three checks `ok: true`.
- Kept the "handwriting" simulation to an italic serif font at a slight rotation rather than sourcing an actual cursive/handwriting font file — avoids adding a font asset (and its licensing considerations) for a difficulty tier that only needs to be "not machine-text," not visually convincing.
- Line item counts: 3–6 for clean/scanned/edge-case docs, 28–42 for the multipage group (chosen to reliably overflow one page at the current row height/margins — verified to produce exactly 2 pages on the sampled doc).

### Open questions (carried over / new)
- Temperature/sampling-params incompatibility with `claude-sonnet-5` (from Phase 0) — still unresolved, still a Phase 3 concern. This is the only open item left overall.

### Phase 0 + Phase 1 checkpoints: fully closed (2026-07-31)
Live `GET /health` from the user's own machine: `{"status":"ok","checks":{"db":{"ok":true,"latencyMs":1435},"storage":{"ok":true,"bucket":"erp-documents"},"anthropic":{"ok":true,"model":"claude-sonnet-5"}}}`. All 12 tables confirmed present in the live DB. Nothing outstanding before Phase 2 except the temperature/sampling-params design question above.
