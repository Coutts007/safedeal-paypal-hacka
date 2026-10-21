# Progress

_Last updated: 2026-10-21 (Nairobi)_

## Current phase

**Phase 1: Payment spike (go/no-go)** — **complete, result GO.** Phase 1 report delivered;
**waiting for Peter's "Approved, start Phase 2"** and the PR for `phase-1-payment-spike`. Then GO → Phase 2 (foundation, 22–24 Oct), or NO-GO → fallback decision.

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
- Server-side check: order A's capture is 12.00 USD, seller net 11.29 (fee 0.71), payee seller A.
- **`/spike` browser test passed**: SDK v6 initialised with `clientId`; three approvals authorised
  (CREATED, +29 days); a buyer cancel was handled. Three test authorisations left open (expire
  2026-11-19).

## Blocked / waiting on Peter

- Approve Phase 1 and open the PR for `phase-1-payment-spike` → `main`.
- Optional: glance at seller A's sandbox account (12.00 USD capture, order `8A320971KG958492H`).
- Optional: a second sandbox Business account for seller B (seller A can stand in).

## Next step

Peter: push, open the PR, merge it, and reply "Approved, start Phase 2". Claude then starts Phase 2
(foundation: schema + migrations, `lib/paypal`, `lib/rules`, audit chain, seed) on a new branch
`phase-2-foundation`, due 24 Oct. Paste the outputs. Claude reports GO/NO-GO.
