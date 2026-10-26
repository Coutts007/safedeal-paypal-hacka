import { afterEach, describe, expect, it, vi } from "vitest";
import { connectUrl, LOGIN_SCOPES, parseUserinfo, profileFromCode } from "./identity";

afterEach(() => vi.restoreAllMocks());

describe("connectUrl", () => {
  it("builds PayPal's sign-in URL with the code flow, scopes, return URL and state", () => {
    const u = new URL(
      connectUrl({
        connectBase: "https://www.sandbox.paypal.com/connect",
        clientId: "CID",
        redirectUri: "https://safedeal.example/api/auth/paypal/callback",
        state: "abc",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://www.sandbox.paypal.com/connect");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      flowEntry: "static",
      client_id: "CID",
      response_type: "code",
      scope: LOGIN_SCOPES,
      redirect_uri: "https://safedeal.example/api/auth/paypal/callback",
      state: "abc",
      fullPage: "true",
    });
    expect(LOGIN_SCOPES.split(" ")).toContain("openid");
  });
});

describe("parseUserinfo", () => {
  it("reads the paypalv1.1 shape, preferring the primary confirmed email", () => {
    const r = parseUserinfo({
      user_id: "https://www.paypal.com/webapps/auth/identity/user/abc",
      name: "David Otieno",
      payer_id: "PAYER123",
      verified_account: "true",
      emails: [
        { value: "old@example.com", primary: false, confirmed: true },
        { value: "David@Example.com", primary: true, confirmed: true },
      ],
    });
    expect(r).toEqual({
      ok: true,
      profile: {
        paypalUserId: "https://www.paypal.com/webapps/auth/identity/user/abc",
        email: "david@example.com",
        name: "David Otieno",
        payerId: "PAYER123",
        verifiedAccount: true,
      },
    });
  });

  it("reads the OpenID shape", () => {
    const r = parseUserinfo({ sub: "abc", email: "s@example.com", email_verified: true });
    expect(r).toMatchObject({ ok: true, profile: { paypalUserId: "abc", email: "s@example.com" } });
  });

  it("refuses an answer without a user id or an email", () => {
    expect(parseUserinfo({ emails: [{ value: "a@b.co" }] })).toMatchObject({ ok: false });
    expect(parseUserinfo({ user_id: "x" })).toEqual({
      ok: false,
      reason: "PayPal did not share an email address",
    });
    expect(parseUserinfo("nonsense")).toMatchObject({ ok: false });
  });
});

describe("profileFromCode", () => {
  const opts = { apiBase: "https://api.test", clientId: "CID", clientSecret: "SEC", code: "C0DE" };

  it("exchanges the code with Basic auth, then reads userinfo with the user's token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return String(url).endsWith("/v1/oauth2/token")
        ? Response.json({ access_token: "USER-TOKEN", token_type: "Bearer" })
        : Response.json({ user_id: "u1", emails: [{ value: "s@example.com", primary: true }] });
    });
    const r = await profileFromCode(opts);
    expect(r).toMatchObject({ ok: true, value: { paypalUserId: "u1", email: "s@example.com" } });
    expect(calls[0].url).toBe("https://api.test/v1/oauth2/token");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("CID:SEC").toString("base64")}`,
    );
    expect(calls[0].init.body).toBe("grant_type=authorization_code&code=C0DE");
    expect(calls[1].url).toBe("https://api.test/v1/identity/oauth2/userinfo?schema=paypalv1.1");
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer USER-TOKEN",
      "Content-Type": "application/json",
    });
  });

  it("reports a refused code without leaking anything", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 400, headers: { "paypal-debug-id": "dbg1" } }),
    );
    const r = await profileFromCode(opts);
    expect(r).toEqual({ ok: false, reason: "code exchange failed: HTTP 400 (debug_id dbg1)" });
    expect(JSON.stringify(r)).not.toContain("SEC");
  });

  it("falls back to the OpenID userinfo endpoint when paypalv1.1 is refused", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "T" });
      if (String(url).includes("schema=paypalv1.1")) {
        return Response.json({ name: "INVALID_REQUEST" }, { status: 400 });
      }
      return Response.json({ sub: "u2", email: "s2@example.com", email_verified: true });
    });
    const r = await profileFromCode(opts);
    expect(r).toMatchObject({ ok: true, value: { paypalUserId: "u2", email: "s2@example.com" } });
    expect(urls[2]).toBe("https://api.test/v1/identity/openidconnect/userinfo?schema=openid");
  });

  it("names PayPal's error code from both userinfo refusals", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/v1/oauth2/token")
        ? Response.json({ access_token: "T", scope: "openid email" })
        : Response.json(
            { error: "insufficient_scope", error_description: "s@example.com" },
            { status: 403, headers: { "paypal-debug-id": "d" } },
          ),
    );
    const r = await profileFromCode(opts);
    expect(r).toEqual({
      ok: false,
      reason:
        "userinfo failed: HTTP 403 insufficient_scope (debug_id d); openid: HTTP 403 insufficient_scope (debug_id d) [scope: openid email]",
    });
    expect(JSON.stringify(r)).not.toContain("s@example.com");
  });

  it("logs PayPal's short error description", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: "invalid_request", error_description: "Missing header" },
        { status: 400, headers: { "paypal-debug-id": "d" } },
      ),
    );
    const r = await profileFromCode(opts);
    expect(r).toEqual({
      ok: false,
      reason: 'code exchange failed: HTTP 400 invalid_request "Missing header" (debug_id d)',
    });
  });
});
