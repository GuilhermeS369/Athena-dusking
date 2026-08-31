# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Athena Scheduler (package name `athena-scheduler`) — a multi-tenant Next.js panel for organizing media and scheduling posts across Instagram (native "Instagram Login for Business") and X/Twitter (via the Zernio provider). UI copy, commit messages in this repo, and most in-app strings are Portuguese (pt-BR); code identifiers are English.

## Commands

```bash
npm run dev              # Next.js dev server
npm run build             # production build (tsc via next build)
npm run lint               # next lint
npm test                    # node --test lib/**/*.test.ts — runs ALL *.test.ts under lib/
```

Run a single test file directly (Node 22's native TS stripping runs `.ts` tests without ts-node/tsx):

```bash
node --test lib/twitter/pricing.test.ts
```

Type-check without emitting:

```bash
npx tsc --noEmit
```

Workers (long-running or `--once` one-shot pollers) are invoked via `npm run worker:<name>` / `npm run worker:<name>:once` — see the `scripts` block in [package.json](package.json) for the full list (publication, publication-generation, media-maintenance, profile-analytics, zernio-sync, twitter:publication/preparation/sync/analytics/reconcile/connect/observability). Workers under `scripts/workers/*.ts` run with `tsx`; `.mjs` workers run directly with `node`.

Load-testing and one-off operational scripts live under `scripts/load-test/` and `scripts/workers/` (the latter also contains many incident-specific investigation/repair scripts — see Housekeeping below).

## Architecture

### Stack
- **Next.js 15 App Router** (React 19) for both the UI and all API routes.
- **Supabase**: Postgres + RLS for data/auth, Storage for private media. [lib/supabase/server.ts](lib/supabase/server.ts) builds a cookie-bound, RLS-respecting client for Server Components/routes; [lib/supabase/admin.ts](lib/supabase/admin.ts) builds a service-role client for workers/internal routes that must bypass RLS. [lib/supabase/browser.ts](lib/supabase/browser.ts) is the client-side equivalent.
- [middleware.ts](middleware.ts) deliberately does **no** auth work and imports nothing server-only — auth is checked per-page/per-route instead, because a server-only import here breaks the Edge bundle on Vercel.
- [server.js](server.js) and [api/index.js](api/index.js) are legacy Express leftovers, **not** the deployed entry point. Vercel must use the Next.js framework preset.

### Multi-tenancy
Every request is scoped to an **organization**. [lib/organizations/server.ts](lib/organizations/server.ts)'s `getOrganizationContext()` (React `cache()`-wrapped) resolves the signed-in user, their organizations, and the active one (from the `athena-active-organization` cookie, defaulting to the first membership). Roles are `admin | operator | viewer`. [app/(painel)/layout.tsx](app/(painel)/layout.tsx) redirects unauthenticated users to `/login` and orgless users to `/onboarding`, then renders `AppShell` with the resolved org context — this is the gate every panel page sits behind.

### Route groups
- `app/(painel)/*` — the authenticated panel (Instagram flows: perfis, grupos, postagem, agenda, galeria, queue, operacao, administracao, zernio; X/Twitter flows under `app/(painel)/x/*`: perfis, grupos, postagem, fila, agenda, analises, logs, zernio).
- `app/api/*` — public/user-facing API routes, organized by domain (`auth`, `groups`, `profiles`, `publications`, `x/*`, `integrations`, `dashboard`, ...).
- `app/api/internal/*` — worker-only endpoints (dispatch, claims, results, heartbeat, circuit-breaker, fallback, sync for both Instagram and Twitter). These are **not** meant to be called by the browser.

### Publication pipeline (Instagram)
A persistent Postgres queue (not a message broker) drives publishing: items are claimed with leases + fencing tokens, processed against the Instagram Graph API, and results/retries are written back. The dispatcher lives at `app/api/internal/publication-dispatch/route.ts` and is invoked once a minute by Vercel Cron (see [vercel.json](vercel.json)). Scheduling has specific business rules documented in [README.md](README.md) (single-date times are preserved exactly; recurring/no-date times pick a random minute inside a 10-minute window and enforce one post per minute per profile) — read that section before touching scheduling logic.

**Antes de ajustar capacidade/vazão da fila, leia [docs/fila-de-publicacao-mapa-de-controles.md](docs/fila-de-publicacao-mapa-de-controles.md)** — em especial a seção "Como aumentar a velocidade a partir daqui", que diz qual teto morde primeiro (hoje: o espaçamento serializado de 75 ms da Zernio, a 92% do limite) e as duas saídas para passar dele. Ele mapeia onde fica cada parâmetro, o que cada um controla de verdade, quais experimentos já falharam (para não repetir), e as armadilhas de medição — a principal sendo que `published_at` marca a **confirmação**, não a publicação; para medir capacidade use `provider_creation_started_at`.

Docs worth reading before deep publication-pipeline work: [docs/athena-publication-pipeline-v2-2026-08-24.md](docs/athena-publication-pipeline-v2-2026-08-24.md), [docs/publication-worker-recovery-plan.md](docs/publication-worker-recovery-plan.md), [docs/vps-worker-runbook.md](docs/vps-worker-runbook.md).

### X/Twitter module
A parallel module (currently mid-rollout, gated by feature flags) mirrors the Instagram flows for X/Twitter, publishing through the **Zernio** third-party provider rather than talking to X's API directly.
- Feature gating lives in [lib/twitter/feature.ts](lib/twitter/feature.ts): `isTwitterModuleEnabled(organizationId)` checks `TWITTER_MODULE_ENABLED` (global) or membership in the comma-separated `TWITTER_CANARY_ORGANIZATION_IDS` allowlist; analytics and bulk-schedule-v2 have their own layered flags. Always gate new X/Twitter surface area through these helpers rather than reading `process.env` directly.
- Internal worker endpoints follow a shared-secret pattern, e.g. `isTwitterWorkerAuthorized(request, role)` in [lib/twitter/worker-auth.ts](lib/twitter/worker-auth.ts) — internal routes are thin (auth check → validate body shape → call a Postgres RPC via the admin client → map the error).
- `lib/twitter/*` and `lib/integrations/zernio-*` hold the domain logic (pricing, media, bulk, analytics, fallback, OAuth turns, connection provisioning/import). Zernio-specific concerns (accounts, OAuth safety, slot reservations, group assignment, duplicate/removal handling) are split into many focused `zernio-*.ts` files under `lib/integrations/` — search there before assuming logic lives under `lib/twitter/`.
- **Continuity docs are the source of truth for current rollout state** — read them before making changes in this area: [docs/x-twitter/README.md](docs/x-twitter/README.md) (current phase/status/checkpoints and an explicit "immediate prohibitions" list — e.g. don't re-run migrations 210–253, don't reset PM2 Instagram processes), [docs/x-twitter/DECISIONS.md](docs/x-twitter/DECISIONS.md), [docs/x-twitter/EXECUTION_LOG.md](docs/x-twitter/EXECUTION_LOG.md), [docs/x-twitter/RUNBOOK.md](docs/x-twitter/RUNBOOK.md) (required before any remote operation), [docs/x-twitter/REQUIREMENTS_MATRIX.md](docs/x-twitter/REQUIREMENTS_MATRIX.md), and the phase files under `docs/x-twitter/phases/`.

### Row limit (PostgREST `max_rows`) — read before writing any Supabase query
The project runs with `max_rows = 5000` (raised from 1000 in Aug 2026). The authoritative value lives in the Supabase dashboard under Settings → API; [supabase/config.toml](supabase/config.toml) only mirrors it for local dev and is **not** pushed by `supabase db push`, so change both together. In code the value is `POSTGREST_MAX_ROWS` in [lib/supabase/paginate.ts](lib/supabase/paginate.ts) — import it, never re-type the number.

The cap applies to **every** Data API response, including `service_role` calls from workers and RPCs declared `returns table(...)`. There is no direct Postgres connection anywhere in the repo, so nothing escapes it. Two consequences, both silent — no error, no warning:
- A `.select()` or set-returning `.rpc()` without `.range()` simply stops at the cap.
- **`.limit(N)` above the cap is always a bug.** The server clamps it; the number just hides the cut.

The raised cap is a safety net, not a fix: tables like `publication_items` hold 85k–110k rows per organization. Anything that scales must still paginate or aggregate.

Rule for any query whose row count grows with the size of an organization (profiles, group members, queue items, media links, analytics series):
- The consumer needs the whole set → wrap it in [`fetchAllRows`](lib/supabase/paginate.ts) with a **total `.order()`** plus `.range(from, to)`. Without a total order, paging by range repeats some rows and drops others — a worse bug than the truncation it replaces, because the row count still looks right. "Deterministic" is not enough and the distinction is not academic: ordering by a column that merely *looks* unique is the exact mistake. Measured in production on 2026-08-30, `profile_analytics_daily_metrics` over a 30-day window ordered by `metric_date` alone returned 7,151 rows with 6,942 distinct — 209 repeated, 209 never seen; the repair script built on it reported 166 missing days where there were 7. The same day, queue measurements paging `publication_items` by `execute_at` (449 items share one timestamp in a bulk-scheduling wave) read 11,332 rows with 11,241 distinct, and the throughput conclusions drawn from them were wrong in both directions. **Order by the table's key** — `(metric_date, profile_id, provider)`, `(execute_at, id)` — or by a column with a real unique index. A column pinned by `.eq()` counts as covered. Pages stay at 1000 on purpose, below the server cap; `fetchAllRows` throws if you ask for more than `POSTGREST_MAX_ROWS`, because a page larger than the cap comes back clamped and the loop would mistake it for the end of the data.
- It is a list for the client → use cursor pagination (`.limit(limit + 1)` + keyset cursor), as in [app/api/x/profiles/route.ts](app/api/x/profiles/route.ts) and [lib/profiles/catalog.ts](lib/profiles/catalog.ts).
- It filters by a list of ids → use [`fetchAllRowsByIds`](lib/supabase/chunk.ts) / `runInIdChunks`. A `.in()` with 1000 UUIDs is both a truncation risk and a ~37 KB GET URL.

[lib/supabase/row-limit-guard.test.ts](lib/supabase/row-limit-guard.test.ts) enforces these rules in `npm test`, scanning `app/`, `lib/` and `scripts/`. Four checks: `.limit()` above the cap; `.select()` on a scaling relation without pagination; **`.range()` pagination without a total order** (checked against `RELATION_KEYS`, treating `.eq()`-pinned columns as covered); and `.range()` that can't be attributed to a literal `.from('table')` — the blind spot that let the 2026-08-30 incident through, since a generic helper taking the table as a parameter is invisible to a text scan.

The two ordering checks apply to **all** scanned files including `.mjs` in `scripts/`; the `.select()` check only covers `scripts/` files referenced by `package.json`, because one-shot incident scripts are historical records. When a legitimate case trips a check, register it in that check's allowlist **with the reason** — the point is a conscious decision, not a banned pattern. For the ordering checks the reason must state which ordering is applied and why it is total; if it isn't total, say so plainly rather than inventing a justification.

### Database migrations
`supabase/migrations/` uses sequentially numbered SQL files (300+ and counting) — additive only in current practice (new numbered file per change, no editing old ones). Apply with the Supabase CLI (`npx supabase db push`) per [README.md](README.md). Never re-run a migration number that continuity docs mark as already applied remotely.

### Security-sensitive code
- [lib/security/token-crypto.ts](lib/security/token-crypto.ts) encrypts OAuth tokens before persistence (`TOKEN_ENCRYPTION_KEY`, 32-byte base64). Never select or log `encrypted_access_token`-style columns.
- [lib/security/super-user.ts](lib/security/super-user.ts) and internal-route worker-secret checks gate privileged operations — internal `/api/internal/*` and `/api/x/integrations/zernio/*` routes are protected by shared secrets (`PUBLICATION_WORKER_SECRET`, `CRON_SECRET`, Twitter worker-role secrets), never by the normal user session.
- Env vars ending in `_SECRET`, `_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` must never be exposed client-side (no `NEXT_PUBLIC_` prefix) or logged.

## Housekeeping / gotchas

- The repo root accumulates many dated, single-use investigation/audit/diagnostic JSON, JSONL, log, and `.tar.gz` files (e.g. `*-audit-2026-*.json`, `.zernio-*`, `.dashboard-*`) generated by past incident response. Most patterns are already covered by [.gitignore](.gitignore); don't treat these files as part of the application, and don't add new dated dumps into git history — write throwaway investigation output outside the repo or to an already-ignored pattern.
- `scripts/workers/` mixes the real recurring workers (`publication-worker.mjs`, `twitter-worker.mjs`, `zernio-sync-worker.mjs`, `media-maintenance-worker.mjs`, `profile-analytics-refresh-worker.mjs`, ...) with many one-off incident scripts (`recover-*`, `audit-*`, `diagnose-*`, named-organization scripts like `clean-vini-zernio-residues.mjs`). Check `package.json`'s `scripts` block to see which ones are the actual long-running workers vs. historical one-shots.
- `plans/` holds planning docs for large in-progress efforts (e.g. `plans/plano-modulo-x-twitter-zernio.md` is the X/Twitter module's implementation plan) — check there for the plan behind an in-flight feature before re-deriving it.
- Node.js >= 18 required (`engines` in package.json); the dev environment here runs Node 22.
