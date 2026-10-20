// Phase 1 spike helpers: the AUTHORIZE order body used by `scripts/spike.ts` and `/spike`.
// Deleted or folded into `orders.ts` once Phase 2 builds the real client.

export const SPIKE_AMOUNT_USD = "12.00";

export type ExperienceUrls = { returnUrl: string; cancelUrl: string };

/** `payeeEmail` null = no payee, so the app's own sandbox business account receives the money. */
export function buildSpikeOrder(payeeEmail: string | null, label: string, urls?: ExperienceUrls) {
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: label,
        description: "SafeDeal Phase 1 payment spike",
        amount: { currency_code: "USD", value: SPIKE_AMOUNT_USD },
        ...(payeeEmail && { payee: { email_address: payeeEmail } }),
      },
    ],
    // Only the script needs return URLs (it sends the buyer to the approval link itself);
    // the v6 browser session supplies its own.
    ...(urls && {
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "SafeDeal (sandbox)",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: urls.returnUrl,
            cancel_url: urls.cancelUrl,
          },
        },
      },
    }),
  };
}

type Link = { href: string; rel: string };

export function approvalLink(order: { links?: Link[] }): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}

export type AuthorizedOrder = {
  id: string;
  status: string;
  purchase_units?: {
    payee?: { email_address?: string; merchant_id?: string };
    payments?: {
      authorizations?: { id: string; status: string; expiration_time?: string }[];
      captures?: { id: string; status: string }[];
    };
  }[];
};

export function firstAuthorization(order: AuthorizedOrder) {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}
