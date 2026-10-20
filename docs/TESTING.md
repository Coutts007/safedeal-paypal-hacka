# Testing

## How to run

| Kind                           | Command                                                    | Needs                              |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------- |
| Unit                           | `npm test`                                                 | nothing                            |
| Type check                     | `npm run typecheck`                                        | nothing                            |
| Lint                           | `npm run lint`                                             | nothing                            |
| End to end                     | `npx playwright install chromium` once, then `npm run e2e` | dev server (started automatically) |
| Env / PayPal credentials check | `npx tsx scripts/check-env.ts`                             | `.env` with sandbox keys           |
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
