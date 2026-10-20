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
