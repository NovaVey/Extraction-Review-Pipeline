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

### Checkpoint (STOP HERE — do not proceed to Phase 1 until confirmed)
- [ ] Supabase bucket `erp-documents` confirmed reachable (confirmed programmatically via the Management API `GET` in this session; `/health`'s live storage check got an explicit `403 Host not in allowlist` from this sandbox's own egress policy — worth a real `/health` hit from your machine)
- [ ] Railway Postgres (`Postgres-ERP` in "Upwork Portfolio") confirmed reachable from local dev via `DATABASE_PUBLIC_URL` (deployment status confirmed `SUCCESS` in this session; `/health`'s live DB check timed out from this sandbox — this sandbox can't reach it either, so this needs your own check)
- [x] Anthropic API key confirmed working — real key added to `.env`, `/health`'s live check against `api.anthropic.com` returned `ok: true` with `model: "claude-sonnet-5"`. Still needs your own confirmation in-console that it has credit and a spend limit set (not checkable programmatically).
