# Progress

_Last updated: 2026-10-21 (Nairobi)_

## Current phase

**Phase 2: Foundation** — built on branch `phase-2-foundation`; all tests pass. Phase 2 report
delivered; **waiting for Peter's review** of the PR and "Approved, start Phase 3".

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

### Phase 2

- `lib/db/schema.ts` + `drizzle/0000_init.sql`: all section 6 tables; `0001_audit_append_only.sql`
  trigger. `lib/db/index.ts` (pool, `connect`).
- `lib/audit.ts`: one hash chain (`sha256(prev_hash + canonical row)`), advisory lock,
  `verifyAuditChain`. `lib/hash.ts`: canonical JSON, sha256.
- `lib/deals/terms.ts` (Zod terms, US$500 cap, `termsHash`), `lib/deals/ids.ts` (public ref,
  role tokens).
- `lib/paypal`: `request-id.ts` (`deal-<uuid>-<action>-v<n>`), `result.ts` (ok / retryable /
  final failure), `orders.ts`, `payments.ts` (engine only), `webhooks.ts` (signature verification),
  `disputes.ts` (read), `record.ts` (every call into `payment_requests`).
- `lib/rules/machine.ts`: pure `nextState` for every section 7 row, plus CANCELLED and
  reconciliation triggers. `lib/rules/engine.ts`: `onTermsConfirmed`, `onBuyerApproved`,
  `onTrackingSubmitted`, `onCourierDelivered`, `onBuyerConfirmed`, `onBuyerProblem`,
  `onAdminDecision`, `onCancel`, `onSweep`, `onPaypalWebhook`.
- `scripts/seed.ts` (`npm run db:seed`): demo deals A (A15, US$95) and B (AF1, US$40).
- CI runs DB tests with a Postgres service. Results in `docs/TESTING.md`; decisions logged.
- Review follow-up (Peter's answers): demo parties Shemaya and David (`deals.seller_name`,
  `buyer_name`, migration `0002`); seller B in use; plan amendments written into BUILD_PLAN and
  CLAUDE.md; sweep repeats unanswered captures/voids (same key, only while PayPal still holds the
  money; review after 6 tries); authorise reconciles ORDER_ALREADY_AUTHORIZED.

## Blocked / waiting on Peter

- Review and merge the PR for `phase-2-foundation`.

## Next step

Phase 3 (Deal Room, payment flow and deployment, 25–28 Oct): API routes, Deal Room page with the
v6 button wired to `onBuyerApproved`, Render deployment. Starts after "Approved, start Phase 3".
