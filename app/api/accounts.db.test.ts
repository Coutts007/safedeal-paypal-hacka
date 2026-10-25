import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboard } from "@/lib/accounts/service";
import { closeDb, getDb } from "@/lib/db";
import { accounts, auditLog, deals } from "@/lib/db/schema";
import { setEngineDeps } from "@/lib/rules/engine";
import { resetDb } from "@/tests/db";
import { fakePaypal, TERMS_INPUT, testDeps } from "@/tests/factories";
import { as, ctx, heldDeal, req, view } from "@/tests/routes";
import { POST as startRoute } from "./auth/paypal/start/route";
import { GET as callbackRoute } from "./auth/paypal/callback/route";
import { POST as logoutRoute } from "./auth/logout/route";
import { POST as archiveRoute } from "./dashboard/deals/[ref]/archive/route";
import { POST as createDealRoute } from "./deals/route";
import { POST as receiptRoute } from "./deals/[ref]/receipt/route";
import { POST as termsRoute } from "./deals/[ref]/terms/route";

// Phase 6b through the API routes: Log in with PayPal, deal ownership, the payout email, claiming
// earlier deals, the dashboard lists and archiving. PayPal's identity endpoints are faked with a
// fetch stub; payments use the usual fake engine port.

const db = getDb();

beforeEach(async () => {
  await resetDb(db);
  setEngineDeps(testDeps(db, fakePaypal().port, new Date()).deps);
});
afterEach(() => {
  setEngineDeps(undefined);
  vi.restoreAllMocks();
});
afterAll(closeDb);

type Profile = { user_id: string; email: string; name?: string };
const DAVID: Profile = { user_id: "pp-user-david", email: "seller-a@example.com", name: "David" };
const OTHER: Profile = { user_id: "pp-user-other", email: "other@example.com", name: "Other" };

/** PayPal's token and userinfo endpoints, answering for `profile` (or failing with `status`). */
function fakeIdentity(profile: Profile, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (status !== 200) return new Response("{}", { status });
    return String(url).includes("/v1/oauth2/token")
      ? Response.json({ access_token: "user-token", token_type: "Bearer" })
      : Response.json({
          user_id: profile.user_id,
          name: profile.name,
          emails: [{ value: profile.email, primary: true, confirmed: true }],
        });
  });
}

const cookieValue = (res: Response, name: string) => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
};

/** The whole login: start → PayPal → callback. Returns the session cookie header. */
const start = () => startRoute(req("POST", {}));
const startUrl = async (res: Response) => new URL(((await res.json()) as { url: string }).url);

async function login(profile: Profile) {
  const res = start();
  const state = cookieValue(res, "sd_oauth") as string;
  const to = await startUrl(res);
  expect(to.searchParams.get("state")).toBe(state);
  fakeIdentity(profile);
  const back = await callbackRoute(
    new Request(`http://localhost:3000/api/auth/paypal/callback?code=C0DE&state=${state}`, {
      headers: { cookie: `sd_oauth=${state}` },
    }),
  );
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("http://localhost:3000/dashboard");
  return `sd_seller=${encodeURIComponent(cookieValue(back, "sd_seller") as string)}`;
}

const account = async (email: string) =>
  (await db.select().from(accounts).where(eq(accounts.email, email)))[0];

async function createAsSeller(cookie: string | null, payeeEmail = "typed@example.com") {
  const res = await createDealRoute(
    req(
      "POST",
      { sellerName: "David", buyerName: "Shemaya", terms: { ...TERMS_INPUT, payeeEmail } },
      cookie ? { cookie } : {},
    ),
  );
  expect(res.status).toBe(201);
  const { ref, links } = (await res.json()) as { ref: string; links: { seller: string } };
  return { ref, seller: decodeURIComponent(new URL(links.seller).searchParams.get("t") as string) };
}

const dash = async (email: string) =>
  dashboard(db, await account(email), {
    now: new Date(),
    timeScale: 1,
    kesPerUsd: 130,
    appBaseUrl: "http://localhost:3000",
  });

describe("Log in with PayPal", () => {
  it("sends the seller to PayPal's sandbox sign-in with the code flow and a return URL", async () => {
    const to = await startUrl(start());
    expect(to.origin + to.pathname).toBe("https://www.sandbox.paypal.com/connect");
    expect(to.searchParams.get("client_id")).toBe("test-id");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/paypal/callback",
    );
    // No GET redirect to PayPal (Safe Browsing flagged it as phishing), and JSON only.
    const form = new Request("http://localhost/api/auth/paypal/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(startRoute(form).status).toBe(415);
  });

  it("creates the account from PayPal's profile and stores no PayPal token", async () => {
    await login(DAVID);
    const a = await account("seller-a@example.com");
    expect(a).toMatchObject({ paypalUserId: "pp-user-david", name: "David" });
    expect(JSON.stringify(a)).not.toContain("user-token");
    // Logging in again updates the same account.
    await login({ ...DAVID, name: "David O." });
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect((await account("seller-a@example.com")).name).toBe("David O.");
  });

  it("refuses a login this browser did not start, a cancelled one, and a PayPal failure", async () => {
    const call = (q: string, cookie = "sd_oauth=real-state") =>
      callbackRoute(
        new Request(`http://localhost:3000/api/auth/paypal/callback?${q}`, { headers: { cookie } }),
      );
    const spy = fakeIdentity(DAVID);
    const forged = await call("code=C&state=attacker-state");
    expect(forged.headers.get("location")).toContain("/login?error=expired");
    expect(cookieValue(forged, "sd_seller")).toBeNull();
    expect((await call("code=C&state=real-state", "")).headers.get("location")).toContain(
      "error=expired",
    );
    expect((await call("error=access_denied")).headers.get("location")).toContain(
      "error=cancelled",
    );
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    fakeIdentity(DAVID, 401);
    const failed = await call("code=C&state=real-state");
    expect(failed.headers.get("location")).toContain("error=paypal");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("logs out by clearing the cookie", async () => {
    const res = logoutRoute();
    expect(res.headers.get("set-cookie")).toMatch(/^sd_seller=;.*Max-Age=0/);
  });
});

describe("deals of a logged-in seller", () => {
  it("belong to the account and pay out to its PayPal email, whatever the form sent", async () => {
    const cookie = await login(DAVID);
    const d = await createAsSeller(cookie, "attacker@example.com");
    expect((await view(d.ref, d.seller)) as unknown).toMatchObject({
      terms: { payeeEmail: "seller-a@example.com" },
    });
    const [row] = await db.select().from(deals).where(eq(deals.publicRef, d.ref));
    expect(row.sellerAccountId).toBe((await account("seller-a@example.com")).id);

    // Without a session the typed email is used and nobody owns the deal.
    const anon = await createAsSeller(null, "typed@example.com");
    const [a] = await db.select().from(deals).where(eq(deals.publicRef, anon.ref));
    expect(a.sellerAccountId).toBeNull();
  });

  it("cannot have the payout email changed by either party", async () => {
    const cookie = await login(DAVID);
    const d = await createAsSeller(cookie);
    const changed = { terms: { ...TERMS_INPUT, payeeEmail: "new@example.com" } };
    const res = await termsRoute(req("POST", changed, as(d.seller)), ctx(d.ref));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/cannot be changed/) });
    // Other changes still work.
    const price = { terms: { ...TERMS_INPUT, price: { amount: "90.00", currency: "USD" } } };
    expect((await termsRoute(req("POST", price, as(d.seller)), ctx(d.ref))).status).toBe(200);
  });

  it("adds earlier link-only deals that pay out to the account's email at login", async () => {
    const mine = await createAsSeller(null, "seller-a@example.com");
    const theirs = await createAsSeller(null, "someone-else@example.com");
    await login(DAVID);
    const refs = Object.values((await dash("seller-a@example.com")).lists)
      .flat()
      .map((r) => r.ref);
    expect(refs).toContain(mine.ref);
    expect(refs).not.toContain(theirs.ref);
    const linked = await db.select().from(auditLog).where(eq(auditLog.action, "account.linked"));
    expect(linked).toHaveLength(1);
  });
});

describe("dashboard and archiving", () => {
  it("moves a deal from Needs you to In progress to Finished, and archives it", async () => {
    const d = await heldDeal(); // pays out to seller-a@example.com, made before logging in
    const cookie = await login(DAVID);
    let lists = (await dash("seller-a@example.com")).lists;
    expect(lists.needs.map((r) => [r.ref, r.todo])).toEqual([
      [d.ref, "Paid: ship it and add tracking"],
    ]);
    expect(lists.needs[0].path).toBe(`/deal/${d.ref}?t=${encodeURIComponent(d.seller)}`);
    expect((await dash("seller-a@example.com")).totals).toMatchObject({ onHold: "95.00" });

    // Not finished yet: it cannot be archived.
    const early = await archiveRoute(req("POST", { archived: true }, { cookie }), ctx(d.ref));
    expect(early.status).toBe(409);

    await receiptRoute(req("POST", { action: "confirm" }, as(d.buyer)), ctx(d.ref));
    lists = (await dash("seller-a@example.com")).lists;
    expect(lists.done.map((r) => r.ref)).toEqual([d.ref]);
    expect((await dash("seller-a@example.com")).totals).toMatchObject({
      onHold: "0.00",
      paidOut: "95.00",
    });

    const res = await archiveRoute(req("POST", { archived: true }, { cookie }), ctx(d.ref));
    expect(res.status).toBe(200);
    lists = (await dash("seller-a@example.com")).lists;
    expect(lists.done).toEqual([]);
    expect(lists.archived.map((r) => r.ref)).toEqual([d.ref]);
    // Archiving hides the deal; it does not change it.
    expect((await view(d.ref, d.seller)).state).toBe("CAPTURED");

    await archiveRoute(req("POST", { archived: false }, { cookie }), ctx(d.ref));
    expect((await dash("seller-a@example.com")).lists.done.map((r) => r.ref)).toEqual([d.ref]);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["deal.archived", "deal.unarchived"]));
  });

  it("only lets the owner archive, only when logged in, and only with JSON", async () => {
    const d = await heldDeal();
    await receiptRoute(req("POST", { action: "confirm" }, as(d.buyer)), ctx(d.ref));
    await login(DAVID);
    const other = await login(OTHER);
    expect(
      (await archiveRoute(req("POST", { archived: true }, { cookie: other }), ctx(d.ref))).status,
    ).toBe(404);
    expect((await archiveRoute(req("POST", { archived: true }), ctx(d.ref))).status).toBe(401);
    const form = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: other },
      body: "archived=true",
    });
    expect((await archiveRoute(form, ctx(d.ref))).status).toBe(415);
    expect((await dash("other@example.com")).totals.count).toBe(0);
  });
});
