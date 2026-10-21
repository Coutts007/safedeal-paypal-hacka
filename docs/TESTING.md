# Testing

## How to run

| Kind                           | Command                                                    | Needs                              |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------- |
| Unit                           | `npm test`                                                 | nothing                            |
| Type check                     | `npm run typecheck`                                        | nothing                            |
| Lint                           | `npm run lint`                                             | nothing                            |
| End to end                     | `npx playwright install chromium` once, then `npm run e2e` | dev server (started automatically) |
| Env / PayPal credentials check | `npx tsx scripts/check-env.ts`                             | `.env` with sandbox keys           |
| Payment spike (Phase 1)        | `npm run spike`                                            | `.env`, sandbox buyer login        |
| Sandbox integration            | added in Phase 2                                           | `.env`, network                    |

CI (`.github/workflows/ci.yml`) runs lint, type check and unit tests on every push.

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
  Still to confirm by hand: the 12.00 USD capture shows in seller A's sandbox account.
