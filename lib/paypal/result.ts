import { paypalFetch, type PaypalFetchOptions, type PaypalResponse } from "./client";

/** Outcome of one PayPal call in a form the rule engine can act on without reading raw JSON. */
export type PaypalResult<T> =
  | { ok: true; value: T; status: number; debugId: string | null }
  | {
      ok: false;
      /** Null when PayPal could not be reached. */
      status: number | null;
      debugId: string | null;
      /** PayPal's issue code (e.g. AUTHORIZATION_ALREADY_CAPTURED), or the error name. */
      issue: string;
      /** True when repeating the same request (same request id) may succeed later. */
      retryable: boolean;
    };

type ErrorBody = { name?: string; details?: { issue?: string }[] };

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Call PayPal and turn the response into a PaypalResult, parsing the body with `parse` on success. */
export async function callPaypal<J, T>(
  path: string,
  options: PaypalFetchOptions,
  parse: (json: J) => T,
): Promise<PaypalResult<T>> {
  let res: PaypalResponse<J>;
  try {
    res = await paypalFetch<J>(path, options);
  } catch (e) {
    return { ok: false, status: null, debugId: null, issue: (e as Error).message, retryable: true };
  }
  if (!res.ok) {
    const body = res.json as ErrorBody;
    return {
      ok: false,
      status: res.status,
      debugId: res.debugId,
      issue: body.details?.[0]?.issue ?? body.name ?? `HTTP_${res.status}`,
      retryable: isRetryableStatus(res.status),
    };
  }
  try {
    return { ok: true, value: parse(res.json), status: res.status, debugId: res.debugId };
  } catch (e) {
    return {
      ok: false,
      status: res.status,
      debugId: res.debugId,
      issue: `UNEXPECTED_RESPONSE: ${(e as Error).message}`,
      retryable: false,
    };
  }
}
