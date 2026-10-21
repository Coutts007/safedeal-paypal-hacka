# Testing

## How to run

| Kind                           | Command                                                    | Needs                              |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------- |
| Unit                           | `npm test`                                                 | nothing                            |
| Database                       | `npm run test:db`                                          | `npm run db:up` (Docker Postgres)  |
| Type check                     | `npm run typecheck`                                        | nothing                            |
| Lint                           | `npm run lint`                                             | nothing                            |
| End to end                     | `npx playwright install chromium` once, then `npm run e2e` | dev server (started automatically) |
| Env / PayPal credentials check | `npx tsx scripts/check-env.ts`                             | `.env` with sandbox keys           |
| Payment spike (Phase 1)        | `npm run spike`                                            | `.env`, sandbox buyer login        |
| Sandbox integration            | `npm run test:sandbox`                                     | `.env`, network                    |
| Demo data                      | `npm run db:seed` (add `-- --agreed`)                      | Postgres, `SANDBOX_SELLER_A_EMAIL` |

CI (`.github/workflows/ci.yml`) runs lint, type check, unit tests and database tests (with a
Postgres 16 service) on every push. Database tests create and migrate their own database
(`TEST_DATABASE_URL`, default `safedeal_test` on port 5433), so they never touch dev data.

## Latest results

### Phase 0 (2026-10-20)

- `npm test`: 1 file, 4 tests passed (`lib/env.test.ts`).
- `npm run typecheck`: no errors.
- `npm run lint`: no errors. `npm run format:check`: clean.
- `npm run build`: succeeded (Next.js 15.5).
- Dev server: `GET /` on port 3000 returned the SafeDeal page.
- Not run yet: Playwright (`e2e/home.spec.ts`) — needs `npx playwright install chromium`
  (large download on a slow link); `scripts/check-env.ts` — needs Peter's renamed `.env`.

### Phase 1 (2026-10-20)

- `npm test`: 2 files, 9 tests passed (`lib/env.test.ts`, `lib/paypal/client.test.ts`).
- Type check, lint, format: clean.
- `npm run spike`, run up to the approval prompt: order created in the sandbox (HTTP 200,
  intent AUTHORIZE, payee = seller A), approval link printed. The rest needs the sandbox buyer
  (Peter). One earlier attempt failed with `fetch failed` (transient network); the script now
  prints the underlying cause.
- Dev server: `GET /spike` 200 with `<paypal-button type="pay" hidden>`; `POST /api/spike/order`
  returned a CREATED order; `GET /api/spike/client-token` returned a token; bad `orderId` → 400.
- Not verified by Claude: the v6 button in a real browser, buyer approval, capture and void.
  These are Peter's Gate 1 steps.
- Note: `npm run dev` hit the Linux file-watcher limit (`ENOSPC`). Use `npm run dev:poll`, or raise
  the limit once: `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`.
- **Peter, `npm run spike -- --self-payee` (control, no payee): 13/13 passed, GO.** Authorise
  (HTTP 201, expires +29 days), capture COMPLETED, same request id replayed the same capture
  (HTTP 200), new request id refused `AUTHORIZATION_ALREADY_CAPTURED`, exactly one capture; void
  accepted, status VOIDED, capture after void refused `AUTHORIZATION_VOIDED`. Run
  `32d557ca-d5cc-40f5-ac77-07c91207f806`.
- First seller-A run: both orders stayed `PAYER_ACTION_REQUIRED` (Enter pressed before approval
  finished); the script now waits for APPROVED.
- **Peter, `npm run spike` (payee = seller A): 15/15 passed, GO.** Payee in the order response
  matched seller A's email (`merchant_id` not returned in the create response). Order A: approved,
  authorise HTTP 201 (expires 2026-11-19, +29 days), capture COMPLETED, same request id replayed the
  same capture (HTTP 200), new request id refused `AUTHORIZATION_ALREADY_CAPTURED`, exactly one
  capture. Order B: approved, authorised, void HTTP 200, status VOIDED, capture after void refused
  `AUTHORIZATION_VOIDED`. Run `a132c242-e872-4c50-af59-9598f64a17e6`.
- **Claude, read-only `GET /v2/checkout/orders/8A320971KG958492H` (2026-10-21):** order COMPLETED,
  payee email = seller A, authorisation CAPTURED, capture COMPLETED 12.00 USD with seller net 11.29
  after a 0.71 PayPal fee, so the money is booked to seller A. `merchant_id` is not returned on the
  order even after capture. Peter's visual check of seller A's sandbox account is still welcome.
- **Peter, `/spike` browser test (SDK v6, `npm run dev:poll`): passed.** SDK initialised with
  `clientId` (no client-token fallback needed). Three buyer approvals (orders `5N785909AR225141Y`,
  `24L73044TB956062N`, `3ND72630PT258970W`) were each authorised on the server: CREATED, expires
  +29 days. One cancel in between was reported as "Buyer cancelled" and did not break later
  payments. Those three authorisations were left open; they expire on 2026-11-19.
- Unit tests 12/12, `npm run typecheck` and `npm run lint` clean (2026-10-21).

### Phase 2 (2026-10-21)

- After the review follow-up: `npm test` 121 passed, `npm run test:db` 31 passed (adds: the sweep
  repeats an unanswered capture with the same key; a void unanswered 6 times goes to review and
  the sweep then stops calling PayPal and stops writing audit rows; ORDER_ALREADY_AUTHORIZED uses
  the order's existing authorisation), `npm run test:sandbox` 3 passed, 1 skipped (adds seller B
  as payee). Seed: A David → Shemaya, B Shemaya → David, both AGREED.
- First run: `npm test`: 111 unit tests passed, including one per section 7 transition
  (`lib/rules/machine.test.ts`) and the rule 1 guard (`lib/rules/rule1.test.ts`; checked that it
  fails on a planted import of `lib/paypal/payments`).
- `npm run test:db`: 28 tests passed against Docker Postgres 16: audit chain (links, refuses
  UPDATE/DELETE, detects a changed and a deleted row with the trigger bypassed, 10 concurrent
  appends stay one chain); engine with a fake PayPal (terms lock, authorise, wrong order id
  refused, amount mismatch refused, FUNDING_FAILED, **two simultaneous buyer confirmations capture
  once**, retryable error keeps the same key, refusal → CAPTURE_FAILED and admin retry with `-v2`,
  ALREADY_CAPTURED reconciled, **two simultaneous sweeps void once**, happy path to capture after
  the inspection window, no capture on time alone, lost capture/void replies reconciled, webhook
  re-reads, dispute); `payment_requests` recorder.
- `npm run test:sandbox`: 2 passed, 1 skipped (opt-in void). Created an AUTHORIZE order with
  seller A as payee (custom_id, amount and payee echoed), same request id returned the same order,
  unknown authorisation reported as non-retryable.
- `npm run db:seed -- --agreed`: two demo deals created and AGREED (95.00 and 40.00 USD).
- Type check, lint, format: clean. `npm run build`: succeeded.
