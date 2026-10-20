# SafeDeal

Pay on proof for deals agreed in chat, built on PayPal authorise-and-capture.

People in Kenya and elsewhere agree deals in WhatsApp and Instagram chats, and someone always has to
trust first. With SafeDeal, the seller pastes the chat, an AI proposes a deal card, both parties
confirm it, and the buyer pays with PayPal. The money stays **on hold on the buyer's own PayPal
account** until delivery is proven. If the seller misses the shipping deadline, the hold is released
automatically.

**The AI proposes, the rule engine decides.** No AI output can move money.

> Status: under construction for the PayPal "Build What's Next with PayPal and AI" hackathon.
> Sandbox only. The full README (demo URL, test logins, architecture, evaluation) comes in Phase 7.

## Run locally

```bash
cp .env.example .env        # fill in sandbox values
npm install
npm run db:up               # Postgres in Docker
npm run dev                 # http://localhost:3000
npm test
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
