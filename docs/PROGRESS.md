# Progress

_Last updated: 2026-10-21 (Nairobi)_

## Current phase

**Phase 1: Payment spike (go/no-go)** — control run 13/13 and seller-A payee run 15/15, both GO.
**Waiting for Peter** to confirm the capture landed in seller A's sandbox account and to run the
`/spike` browser test. Then the Phase 1 report. Then GO → Phase 2 (foundation, 22–24 Oct), or NO-GO → fallback decision.

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
- `--self-payee` control run; the script waits for the order to be APPROVED before authorising;
  approval links return to `/spike/returned` (tells the buyer to go back to the terminal).
- **Control run (`npm run spike -- --self-payee`, no payee): 13/13 passed, GO.** Authorise HTTP 201
  (expires +29 days), capture COMPLETED, same request id replayed the same capture (HTTP 200), new
  request id refused `AUTHORIZATION_ALREADY_CAPTURED`, exactly one capture; void accepted, status
  VOIDED, capture after void refused `AUTHORIZATION_VOIDED`. Details in `docs/TESTING.md`.
- First seller-A payee run inconclusive: both orders stayed `PAYER_ACTION_REQUIRED` (Enter pressed
  before approval finished). Fixed by the APPROVED wait above.
- **Seller-A payee run (`npm run spike`): 15/15 passed, GO.** Same results as the control run, with
  the order payee set to seller A. Details in `docs/TESTING.md`.

## Blocked / waiting on Peter

- Check seller A's sandbox account for the 12.00 USD capture (order `8A320971KG958492H`).
- Run the `/spike` browser test (see "Next step").
- Optional: a second sandbox Business account for seller B (seller A can stand in).

## Next step

Peter: check seller A's sandbox account, then `npm run dev:poll` → http://localhost:3000/spike and
pay. Paste the outputs. Claude reports GO/NO-GO.
