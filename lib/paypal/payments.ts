import { z } from "zod";
import { callPaypal, type PaypalResult } from "./result";

// Payments v2: capture, void, refund move money. RULE 1: only lib/rules/engine.ts may import this
// file (lib/rules/rule1.test.ts enforces it).

const authSchema = z.object({
  id: z.string(),
  status: z.string(),
  expiration_time: z.string().optional(),
  amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
});
const captureSchema = z.object({ id: z.string(), status: z.string() });

export type AuthorizationDetails = {
  id: string;
  /** CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED, PENDING or EXPIRED. */
  status: string;
  expiresAt: Date | null;
  amount: string | null;
};
export type Capture = z.infer<typeof captureSchema>;

const authPath = (authId: string) => `/v2/payments/authorizations/${encodeURIComponent(authId)}`;

export function capture(
  authId: string,
  requestId: string,
  dealId: string,
): Promise<PaypalResult<Capture>> {
  return callPaypal(
    `${authPath(authId)}/capture`,
    {
      method: "POST",
      body: { final_capture: true },
      requestId,
      record: { dealId, action: "capture" },
    },
    (j) => captureSchema.parse(j),
  );
}

export function voidAuth(
  authId: string,
  requestId: string,
  dealId: string,
): Promise<PaypalResult<null>> {
  return callPaypal(
    `${authPath(authId)}/void`,
    { method: "POST", requestId, record: { dealId, action: "void" } },
    () => null,
  );
}

export function getAuth(
  authId: string,
  dealId: string | null,
): Promise<PaypalResult<AuthorizationDetails>> {
  return callPaypal(authPath(authId), { record: { dealId, action: "get_auth" } }, (j) => {
    const a = authSchema.parse(j);
    return {
      id: a.id,
      status: a.status,
      expiresAt: a.expiration_time ? new Date(a.expiration_time) : null,
      amount: a.amount?.value ?? null,
    };
  });
}

/** Full refund of a capture (stretch goal). */
export function refund(
  captureId: string,
  requestId: string,
  dealId: string,
): Promise<PaypalResult<Capture>> {
  return callPaypal(
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { method: "POST", body: {}, requestId, record: { dealId, action: "refund" } },
    (j) => captureSchema.parse(j),
  );
}
