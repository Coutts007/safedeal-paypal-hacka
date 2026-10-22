# Progress

_Last updated: 2026-10-22 (Nairobi)_

## Current phase

**Phase 3: Deal Room, payment flow and deployment** — built on branch `phase-3-deal-room`;
**STOP FOR PETER**: deploy to Render, add the PayPal webhook, run Gate 2 (see "Next step").

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

### Phase 3

- Merged the Phase 2 follow-up commits that missed PR #3 (names, seller B, retries, amendments).
- `lib/deals/service.ts`: create deal, propose terms (DRAFT only; buyer cannot change payee),
  token check (constant time), Deal Room view (status line, timeline, deadlines, actions, history).
- `lib/rules/engine.ts`: `preparePayment` (create or reuse the PayPal order; new attempt after a
  failure), `setEngineDeps` test hook.
- Routes: `POST /api/deals`, `GET /api/deals/[ref]`, `POST …/terms|confirm|cancel|order|authorize|
evidence|receipt`, `POST /api/webhooks/paypal`, `POST /api/cron/sweep`, `GET /api/health`.
- Pages: `/` (hand-entered deal form), `/deal/[ref]?t=` (Deal Room with v6 PayPal button).
- `render.yaml` (web + Postgres + cron), `scripts/migrate.ts`, `scripts/cron-sweep.mjs`.

### Plan update of 22 October (branch `phase-3a-plan-update`, on top of Phase 3)

- `docs/BUILD_PLAN.md` replaced by Peter's 22 Oct plan, keeping the 21 Oct amendments.
- Section 7.1 rules due by Phase 3: a late buyer confirmation or verified courier delivery after a
  deliver-by or day-26 review still pays the seller; a complaint or PayPal problem still needs an
  admin. Reviews have a `kind` and are closed when the deal leaves review.
- `delivery_proof` recorded; ship-by void also requires no recorded delivery.
- `MAX_DEAL_USD` checked again before any PayPal order is created.
- Migration 0003: `delivery_proof`, handover columns, `extensions` table, `reviews.kind`
  (handover and extension behaviour stay in Phase 5).
- Deal Room: deadline-review status lines; buyer can confirm receipt or report a problem there.

## Blocked / waiting on Peter

- Confirm the Render plans (paid web, Postgres and cron; see DECISIONS) before creating them.
- Gate 2 steps in the Phase 3 report: Render Blueprint, environment values, PayPal webhook, then
  one deal to CAPTURED and one to VOIDED on the Render URL.

## Next step

Peter runs Gate 2 and pastes the results. Then Claude checks the webhook rows and audit log,
writes the Phase 3 report's final evidence, and Phase 4 (AI extraction) starts after approval.
