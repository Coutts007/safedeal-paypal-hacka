# Progress

_Last updated: 2026-10-25 (Nairobi)_

## Current phase

**Phase 6b: Seller accounts and dashboard**: built on branch `phase-6b-seller-dashboard`.
**STOP FOR PETER**: enable Log in with PayPal on the sandbox app and log in on Render (see
"Next step").

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

### Phase 4 (merged, PR #6)

- Gate 2 passed on Render (Peter, 2026-10-22).
- `lib/ai/`: `redact.ts` (phones, emails, M-PESA codes, card numbers), `chat.ts` (WhatsApp iOS and
  Android exports, message ids m1…), `schema.ts` (Zod extraction schema with sources and
  confidence per field), `prompt.ts` (`extract-v1`), `extract.ts` (Claude call, one retry with the
  validation problems, refusal handling), `validate.ts` (unknown message ids, amounts, dates,
  instruction-like messages), `proposal.ts` (AI result → pre-filled form; KES → USD marked unsure),
  `service.ts` (stores `ai_extractions` and `ai_runs`), `rate-limit.ts`, `eval-score.ts`.
- Migration 0004: `ai_extractions`, `ai_runs`. A deal made from a chat keeps the redacted chat
  (`chat_sources`) and per-field source refs; edits mark a field "changed by hand".
- `POST /api/extract`; `POST /api/deals` takes an optional `extractionId` (once, within 24 h).
- Create page: paste chat → "Read the chat" → pre-filled form with "AI: sure / check / unsure"
  and "From chat m3" markers, a warning for instruction-like messages, and "fill in by hand".
  Deal Room shows the same markers on the terms card.
- Optional ship-by / deliver-by dates in the terms; payment refused once they have passed.
- `eval/chats/`: 40 labelled English chats (KES, USD, relative dates, 4 injection attempts),
  `TEMPLATE.json`, 2 Swahili and 1 Sheng example; `npm run eval` prints field-level P/R/F1.

### Phase 5 (merged, PR #7)

- Handover code (`lib/deals/handover.ts`): derived from `HANDOVER_SECRET`, only its hash stored
  at authorisation; buyer sees it until delivery is proven; seller enters it
  (`POST /api/deals/[ref]/handover`); a correct code is a verified delivery (also as late proof in
  a deadline review); 5 wrong codes lock entry and flag the deal; the reviewer can unlock.
- Extend delivery date (`POST …/extend`): propose / accept / reject; acceptance makes terms
  version n+1 confirmed by both and brings a deliver-by review back to SHIPPED; day-26 limit; the
  sweep expires stale proposals.
- Courier webhook (`POST /api/webhooks/courier`, HMAC of the raw body, event ids stored once),
  test courier (`POST /api/test-courier/deliver` with `x-test-courier-secret`), and a DEMO_MODE
  "Demo: simulate courier delivery" button in the Deal Room.
- Evidence: notes and photos from either party (`…/evidence`, `…/photos`), stored in Postgres
  (migration 0005), shown to both parties and the reviewer.
- `lib/ai/evidence.ts`: AI compares terms with evidence (photos as images) and labels it
  consistent / inconsistent / uncertain with reasons, for the reviewer only.
- Reviewer page `/admin` (password, signed cookie): queue of open reviews and locked handovers,
  deal page with evidence, courier events, handover record, date changes, payments, chat, audit
  log with chain check, AI check button, capture / void with a written reason, unlock.
- Status lines for every section 7.1 situation (handover lock, complaint, deliver-by and day-26
  reviews, void with the card-hold note, expiry, dispute) and the 3-day honour-period note.
- Dispute evidence bundle download once paid (`GET …/bundle`): a readable PDF since 2026-10-24 (`?format=json` for the data).
- Machine triggers `HANDOVER_VERIFIED`, `EXTENSION_PROPOSED/ACCEPTED/REJECTED`; rule test that
  AI code never reaches the engine and the engine never reads AI labels.

- Gate 3 on Render (Peter, 2026-10-24): the first payment was refused by the sandbox
  (`TRANSACTION_REFUSED`, debug id f89835162e54a: a PayPal-side refusal, advice was a smaller
  amount, PayPal balance or a fresh sandbox buyer); a later deal reached SHIPPED → DELIVERED
  through the test courier from the Render shell. Capture, void and reviewer page not yet
  reported. The test courier secret was pasted in chat twice: rotate it.

### Phase 6

- Money safety tests (`lib/rules/money-safety.db.test.ts`): one per section 7.1 row (money,
  state, what each party and the reviewer see), buyer confirmation racing the sweep (one
  capture), and 25 seeded random 31-day histories without a verified delivery (never a capture).
- Prompt-injection harness: 30 cases in `eval/injection/cases.json` (20 chat, 10 evidence);
  `app/api/injection.db.test.ts` replays them with an AI that obeys every attack (no state
  change); `npm run eval:injection` against Claude: 30/30. Fix found by the harness: untrusted
  text could close its `<note>`/`<chat>` tag or fake a `[m9]` message line; now neutralised
  (`lib/ai/untrusted.ts`, `extract-v3`, `evidence-v2`).
- Full eval with `extract-v3`: 91.7% F1 (v2: 91.4%), per field and per language in
  `docs/TESTING.md` and the README.
- Playwright (`e2e/`), at 360 px against a production build with a fake PayPal API and SDK stub:
  capture path through the UI, void path, duplicate and forged webhook, popup blocked → redirect,
  price tampering, refused payment; runs in CI.
- Accessibility: axe (WCAG 2.1 A/AA) and no sideways scroll on every main screen and state; clean.
- Clear message for `TRANSACTION_REFUSED` on the pay button.
- `npm run demo:reset` (`scripts/demo-reset.ts`, `lib/deals/demo.ts`): fresh agreed demo deals A
  and B, B with a short ship-by; never moves money.

### After Phase 6 (2026-10-25, branch `evidence-bundle-pdf`)

- Evidence bundle is a readable PDF (summary, terms, PayPal ids, delivery, photos, reviews,
  worded timeline, chat, audit check); JSON with `?format=json`.
- `scripts/deal-status.ts`: why a deal has not moved (for the void not happening on Render).
- "AI: unsure" removed (Peter: it would destroy trust). It came from SafeDeal's own KES rule
  (31 of 32 chats), not the AI. Markers now say what to do: "Matches the chat", "Check this",
  "Confirm the US$ price", "Not in the chat"; never red. The Deal Room shows only message links.
  A summary above the form lists what needs the seller. Prompt `extract-v4` recalibrated: "Check
  this" in 8 of 43 chats (was 36), every field still right; eval 91.4% F1, injection 30/30.

### Phase 6b (2026-10-25, branch `phase-6b-seller-dashboard`)

- Log in with PayPal (sandbox) for sellers: `/login`, `POST /api/auth/paypal/start` and `/callback`
  (state cookie against forged logins), `lib/paypal/identity.ts` (code → token → userinfo, the
  token used once and never stored). Signed 8-hour session cookie; no new secret.
- `accounts` table; deals gain an owner and `archived_at` (migration `0006_seller_accounts`).
  At login, earlier link-only deals paying out to the account's PayPal email are added.
- `/dashboard`: totals (on hold, paid to you, deals), tabs Needs you / In progress / Finished /
  Archived, each deal with the one thing to do next and its next date; Open goes to the Deal
  Room as the seller. Archive and unarchive finished deals (hidden only, audited).
- `/dashboard/new`: the usual create form; the deal pays out to the logged-in PayPal account
  and that payee cannot be changed later by either side.
- Buyers are unchanged: they use their private link and never log in.
- Tests: 16 unit, 9 database, 2 e2e (whole seller flow; forged login), axe and 360 px checks on
  the new pages. Download and copy buttons fixed (they turned white; now show progress).

### Chat file upload (2026-10-25, branch `chat-file-upload`)

- "Upload an exported chat" on the create form: WhatsApp `.txt` or the iPhone `.zip`
  (`_chat.txt`), Instagram/Facebook `message_*.json` (or their zip), Telegram `result.json`.
  Turned into text in the browser (`lib/ai/chat-file.ts`); the file never leaves the phone.
  Handles 12-hour and month-first dates, drops system lines and media placeholders, fixes
  Instagram's broken accents and emoji. The AI then reads it straight away.
- The AI now reads up to 40,000 characters / 600 messages (was 15,000 / 300); a longer export
  keeps the latest messages and says so.
- Live check (`claude-sonnet-5-5`, `extract-v4`): a 3-week, 365-message iPhone export with an
  earlier deal and two abandoned offers → the final terms (KES 12,800, G4S, ship 23 Oct from
  "kesho", deliver by Saturday 24 Oct, 4 conditions), the planted injection flagged; 13,821 input
  tokens, 5 s.

## Blocked / waiting on Peter

- Phone test: fund a deal on his phone (sandbox) and report any problems.
- Gate 3 leftovers on Render: buyer confirms → CAPTURED; void path (deal B from
  `demo:reset`); reviewer page with a reported problem. Then rotate `TEST_COURIER_SECRET`.
- Still open from Phase 4: Swahili and Sheng chats (and local-language injection attacks for
  `eval/injection/cases.json`), gold label review, three chats of his own.
- To confirm: handover code derived from a secret (DECISIONS 2026-10-23); refusal fallback on.
- Render upgrade to paid plans by 9 November.

- Log in with PayPal on the sandbox app (Phase 6b): Return URL
  `https://safedeal-4abv.onrender.com/api/auth/paypal/callback`, then a login on Render.
- Why a deal past ship-by was not voided on Render: the `scripts/deal-status.ts` output or the
  cron log.

## Next step

Peter enables Log in with PayPal, merges `phase-6b-seller-dashboard` and logs in on Render. Then
the phone test and Gate 3 leftovers; Phase 7 (submission package, 9 to 11 November)
after his approval.
