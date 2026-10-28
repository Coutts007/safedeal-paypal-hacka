# Devpost submission text

Copy each section into the matching Devpost field.

**Name:** SafeDeal

**Tagline:** Pay on proof for deals agreed in chat: AI reads the WhatsApp deal, PayPal holds the
buyer's money, and it's released only when delivery is proven.

**Links:** demo https://safedeal-4abv.onrender.com · code https://github.com/Coutts007/safedeal-paypal-hacka

## Inspiration

In Kenya, a huge amount of buying and selling happens in WhatsApp and Instagram chats: a used phone
from Nairobi to Nakuru, trainers from a seller you've never met. Someone always has to trust first.
Buyers get scammed by sellers who never ship; sellers get scammed by fake payment screenshots and
"I never received it". Escrow services exist, but they mean a new account, a new app and filling in
the deal all over again. We wanted something that starts from the chat people already have and
uses the PayPal account they already trust.

## What it does

The seller pastes the chat (or uploads the exported chat file). Claude reads it and proposes a deal
card: item, price, courier, ship-by date and conditions, each linked to the message it came from.
Both parties confirm the same terms, then the buyer pays with PayPal. The payment is **authorised,
not captured**: the money stays on hold on the buyer's own PayPal account.

The seller ships and adds tracking, or hands the item over against a 6-digit code the buyer gives
only on receipt. When delivery is proven and the buyer confirms (or a 48-hour inspection window
ends without a complaint), SafeDeal captures the payment. If the seller misses the ship-by date,
the hold is voided automatically and the buyer's money is released. Late deliveries, complaints and
disputes go to a reviewer with the evidence, an AI comparison of the evidence against the terms and
a tamper-evident audit log. Sellers with many buyers log in with PayPal and manage every deal from
one dashboard.

The core rule: **the AI proposes, the rule engine decides.** No AI output can move money.

## How we built it

- **PayPal:** Orders v2 with `intent: AUTHORIZE`, the JS SDK v6 button, Payments v2 capture and
  void, webhooks with signature verification, Log in with PayPal (OpenID Connect) for seller
  accounts, and a read of the Disputes API. Every PayPal POST carries a fixed `PayPal-Request-Id`
  (`deal-<uuid>-<action>-v<n>`), so a retry after a lost reply can never capture twice.
- **Rule engine:** a pure state machine (14 states) and one module that is the only code allowed to
  call capture or void, enforced by a test. Each trigger locks the deal row, decides, calls PayPal,
  and writes the new state and a hash-chained audit entry in one transaction. A cron sweep every 10
  minutes handles deadlines and re-reads PayPal to recover from lost replies.
- **AI:** Claude Sonnet 5.5 reads chats in English, Swahili and Sheng and returns JSON validated
  with Zod. Personal data (phone numbers, emails, card numbers, M-Pesa codes) is redacted before
  the chat leaves the server. Instruction-like messages are flagged, never followed. A second
  prompt compares evidence photos and notes with the terms for the reviewer.
- **Stack:** Next.js 15, TypeScript strict, Tailwind, Postgres with Drizzle, hosted on Render (web
  service, Postgres and a cron job). Mobile first: every screen works at 360 px.
- **Testing:** unit, database and Playwright tests in CI; one test per money-safety rule; a race
  test (buyer confirms while the sweep runs: exactly one capture); 25 random 31-day histories that
  never pay the seller without a verified delivery; an eval of 43 labelled chats (91.4% field-level
  F1) and 30 prompt-injection attacks (30/30 resisted).

## Challenges we ran into

- **Making "time running out" safe.** The obvious design pays the seller when nobody complains.
  We had to make sure a timeout alone can never release money, while a buyer who goes silent after
  delivery can't block payment either. The answer was to require a verified delivery (courier event
  or handover code) before any automatic capture, and to test every situation separately.
- **PayPal authorisations have limits.** An authorisation lasts 29 days and funds are only
  guaranteed for 3, so every deadline had to fit inside the first authorisation, with reviews
  before day 26.
- **Lost replies and repeated events.** Webhooks arrive late, twice or out of order, and a capture
  can succeed on PayPal's side while the reply is lost. Fixed request ids, stored event ids and
  re-reading PayPal before every change made it safe to retry anything.
- **Prompt injection through the chat.** Our own test harness found that a chat line could close
  the tag around untrusted text or fake a message line. We now neutralise both, and a database test
  replays all 30 attacks with an AI that obeys them, to show nothing moves.
- **Sandbox surprises.** A first payment was refused by the sandbox (`TRANSACTION_REFUSED`), voids
  were refused for one payee account but not another, and Log in with PayPal needed fallbacks for
  the userinfo endpoint. Each one taught us to log PayPal's `debug_id` and re-read state instead of
  guessing.

## Accomplishments that we're proud of

- A buyer can pay a stranger from a chat and know the money is still theirs until delivery is
  proven.
- The AI does the tedious part (turning a messy, multilingual chat into a clean deal) but provably
  can't touch the money.
- Every money-safety rule is written down in plain language in the README and backed by a test.

## What we learned

- Authorise-and-capture is a natural fit for pay-on-proof, as long as the rules around it are
  strict.
- Treat everything from an LLM as a proposal from an untrusted source: validate it, show its
  sources and let a person confirm.
- Labels and calibration matter: we replaced an "AI: unsure" marker with plain instructions
  ("Check this", "Confirm the US$ price") because vague doubt destroys trust.

## What's next for SafeDeal

- PayPal Multiparty approval, so SafeDeal can pay sellers as a platform in production.
- Real courier tracking (G4S and others) through a tracking feed.
- Submitting dispute evidence through the Disputes API directly.
- More Swahili and Sheng examples in the eval, and attacks written in those languages.
- Local payment options alongside PayPal.

## AI tools used

- **Claude Sonnet 5.5 (Anthropic API), in the product:** reads chats into deal terms and compares
  evidence with terms for the reviewer. Its output only fills in forms that people confirm; the rule
  engine decides every money movement.
- **Claude Code (Claude Opus), for building:** wrote most of the code, tests and documentation
  under our direction, phase by phase, with every change reviewed through a pull request.
