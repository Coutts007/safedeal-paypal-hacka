# Progress

_Last updated: 2026-10-20 (Nairobi)_

## Current phase

**Phase 0: Intake and setup** — built; waiting for Peter to fix `.env` key names and run the env check.
Next: **Phase 1: payment spike** (target 20–21 Oct).

## Done

- Intake answered (see `docs/DECISIONS.md`).
- Next.js 15 (App Router, TypeScript strict, Tailwind 4), ESLint + Prettier, Vitest, Playwright,
  Drizzle + pg, Zod installed.
- `CLAUDE.md`, `.env.example`, `.gitignore` (all `.env*` ignored except `.env.example`),
  Apache-2.0 `LICENSE`, README stub, `docs/BUILD_PLAN.md`, `DECISIONS.md`, `TESTING.md`.
- `lib/env.ts`: Zod-validated server env (refuses the live PayPal API; never prints values) + tests.
- `scripts/check-env.ts`: reports which variables are set and tests a PayPal sandbox OAuth token.
- Local Postgres 16 in Docker on **port 5433** (5432 is used by another Postgres on this machine).
- GitHub Actions CI: lint, type check, unit tests on every push.

## Blocked / waiting on Peter

- `.env` uses non-standard key names (`Client_ID`, `Secret_Key_1`, `AI_API_KEY`); rename to the
  names in `.env.example` and add the missing ones.
- Only one sandbox Business account listed; plan wants two sellers.
- Confirm which provider the LLM key belongs to (plan assumes Anthropic).

## Next step

Peter runs `npx tsx scripts/check-env.ts` and pastes the output. Then "Approved, start Phase 1".
