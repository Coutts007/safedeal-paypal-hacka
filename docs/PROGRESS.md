# Progress

_Last updated: 2026-10-20 (Nairobi)_

## Current phase

**Phase 1: Payment spike (go/no-go)** — built; **waiting for Peter** to run it with the sandbox
buyer and report. Then GO → Phase 2 (foundation, 22–24 Oct), or NO-GO → fallback decision.

## Done

### Phase 0 (merged)

- Next.js 15 (App Router, TypeScript strict, Tailwind 4), ESLint + Prettier, Vitest, Playwright,
  Drizzle + pg, Zod; `CLAUDE.md`, `.env.example`, `.gitignore`, Apache-2.0 `LICENSE`, docs.
- `lib/env.ts` (Zod-validated env, refuses the live API), `scripts/check-env.ts`.
- Local Postgres 16 in Docker on **port 5433**. GitHub Actions CI.
- `.env` fixed by Peter; `npm run check:env`: all variables set, PayPal sandbox OAuth OK.
- LLM key confirmed as Anthropic.

### Phase 1

- `lib/paypal/client.ts`: OAuth token cache (refresh 60 s early), client token for SDK v6,
  `paypalFetch` (Bearer, `PayPal-Request-Id` required on every non-GET, `Prefer:
return=representation`, returns status + `debug_id`). 5 unit tests with mocked `fetch`.
- `scripts/spike.ts` (`npm run spike`): order A authorise → capture → same-key replay → new-key
  capture refused → exactly one capture; order B authorise → void → status VOIDED → capture
  refused. Prints PASS/FAIL per check and GO/NO-GO. No secrets or emails printed.
- `/spike` page (dev only) with SDK v6: `clientId` init, falls back to a server client token;
  eligibility check; `<paypal-button type="pay">`; popup-blocked → redirect; `hasReturned/resume`.
  Routes `POST /api/spike/order`, `POST /api/spike/authorize`, `GET /api/spike/client-token`
  (all 404 in production).

## Blocked / waiting on Peter

- Run the spike steps (see "Next step").
- Optional: a second sandbox Business account for seller B (seller A can stand in).

## Next step

Peter: `npm run spike` (approve both links as the sandbox buyer), check seller A's sandbox account,
then `npm run dev` → http://localhost:3000/spike and pay. Paste the outputs. Claude reports GO/NO-GO.
