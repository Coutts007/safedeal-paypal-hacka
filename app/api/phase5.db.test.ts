import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEvidenceModel } from "@/lib/ai/evidence-service";
import { SIGNATURE_HEADER, testCourierEvent } from "@/lib/courier/webhook";
import { closeDb, getDb } from "@/lib/db";
import { courierEvents, deals, evidenceChecks, evidenceFiles } from "@/lib/db/schema";
import { resetServerEnvCache } from "@/lib/env";
import { setEngineDeps } from "@/lib/rules/engine";
import { fakeModel } from "@/tests/ai";
import { resetDb } from "@/tests/db";
import { fakePaypal, TERMS_INPUT, testDeps } from "@/tests/factories";
import { as, ctx, heldDeal, PNG, req, state, view } from "@/tests/routes";
import { POST as createDealRoute } from "./deals/route";
import { GET as bundleRoute } from "./deals/[ref]/bundle/route";
import { POST as evidenceRoute } from "./deals/[ref]/evidence/route";
import { POST as extendRoute } from "./deals/[ref]/extend/route";
import { POST as handoverRoute } from "./deals/[ref]/handover/route";
import { POST as photosRoute } from "./deals/[ref]/photos/route";
import { GET as photoRoute } from "./deals/[ref]/photos/[id]/route";
import { POST as receiptRoute } from "./deals/[ref]/receipt/route";
import { POST as simulateRoute } from "./deals/[ref]/simulate-delivery/route";
import { POST as adminCheckRoute } from "./admin/deals/[ref]/check/route";
import { POST as adminDecisionRoute } from "./admin/deals/[ref]/decision/route";
import { GET as adminPhotoRoute } from "./admin/deals/[ref]/photos/[id]/route";
import { POST as adminLoginRoute } from "./admin/login/route";
import { POST as testCourierRoute } from "./test-courier/deliver/route";
import { POST as courierWebhookRoute } from "./webhooks/courier/route";

// Phase 5 through the API routes: handover code, courier webhook and test courier, evidence,
// Extend delivery date, the reviewer's routes and the dispute evidence bundle.

const H = 3_600_000;
const D = 24 * H;
const db = getDb();
let fake: ReturnType<typeof fakePaypal>;
let clock: ReturnType<typeof testDeps>;

beforeEach(async () => {
  await resetDb(db);
  fake = fakePaypal();
  // The real clock: routes that do not go through the engine use new Date().
  clock = testDeps(db, fake.port, new Date());
  setEngineDeps(clock.deps);
});
afterEach(() => {
  setEngineDeps(undefined);
  setEvidenceModel(undefined);
  delete process.env.DEMO_MODE;
  resetServerEnvCache();
});
afterAll(closeDb);

describe("handover code through the Deal Room", () => {
  it("only the buyer sees the code; the seller enters it; wrong codes count down", async () => {
    const d = await heldDeal({ deliveryMethod: "rider" });
    const buyer = await view(d.ref, d.buyer);
    const seller = await view(d.ref, d.seller);
    expect(buyer.handover.code).toMatch(/^\d{6}$/);
    expect(seller.handover.code).toBeNull();
    expect(JSON.stringify(seller)).not.toContain(buyer.handover.code);
    expect(seller.actions).toContain("enter_handover");

    expect(
      (await handoverRoute(req("POST", { code: buyer.handover.code }, as(d.buyer)), ctx(d.ref)))
        .status,
    ).toBe(403);
    const wrong = String((Number(buyer.handover.code) + 1) % 1_000_000).padStart(6, "0");
    const bad = await handoverRoute(req("POST", { code: wrong }, as(d.seller)), ctx(d.ref));
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toContain("4 tries left");

    const good = await handoverRoute(
      req("POST", { code: buyer.handover.code }, as(d.seller)),
      ctx(d.ref),
    );
    expect(await good.json()).toMatchObject({ from: "AUTHORIZED", to: "DELIVERED" });
    expect((await view(d.ref, d.buyer)).handover.code).toBeNull();
  });
});

describe("courier webhook", () => {
  it("refuses a bad signature and stores nothing", async () => {
    const d = await heldDeal({ ship: true });
    const signed = testCourierEvent("wrong-secret", { trackingNumber: "G4S-777", at: new Date() });
    const res = await courierWebhookRoute(
      new Request("http://localhost/api/webhooks/courier", {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      }),
    );
    expect(res.status).toBe(401);
    expect(await db.select().from(courierEvents)).toEqual([]);
    expect(await state(d.id)).toBe("SHIPPED");
  });

  it("a signed delivered event moves the deal to DELIVERED once; repeats are ignored", async () => {
    const d = await heldDeal({ ship: true });
    const signed = testCourierEvent("test-courier-secret", {
      trackingNumber: "g4s-777",
      at: new Date(),
    });
    const send = () =>
      courierWebhookRoute(
        new Request("http://localhost/api/webhooks/courier", {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
        }),
      );
    expect(await (await send()).json()).toMatchObject({
      matched: true,
      result: { to: "DELIVERED" },
    });
    expect(await (await send()).json()).toMatchObject({ duplicate: true });
    expect(await state(d.id)).toBe("DELIVERED");
    expect((await db.select().from(deals).where(eq(deals.id, d.id)))[0].deliveryProof).toBe(
      "courier",
    );
  });

  it("keeps events for unknown tracking numbers without acting", async () => {
    const signed = testCourierEvent("test-courier-secret", {
      trackingNumber: "NOPE-1",
      at: new Date(),
    });
    const res = await courierWebhookRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      }),
    );
    expect(await res.json()).toMatchObject({ matched: false });
    expect(signed.headers.get(SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the test courier route needs its secret", async () => {
    const d = await heldDeal({ ship: true });
    expect((await testCourierRoute(req("POST", { trackingNumber: "G4S-777" }))).status).toBe(401);
    const res = await testCourierRoute(
      req(
        "POST",
        { trackingNumber: "G4S-777" },
        { "x-test-courier-secret": "test-courier-secret" },
      ),
    );
    expect(await res.json()).toMatchObject({ result: { to: "DELIVERED" } });
    expect(await state(d.id)).toBe("DELIVERED");
  });

  it("the demo button works only with DEMO_MODE on", async () => {
    const d = await heldDeal({ ship: true });
    expect((await simulateRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).status).toBe(404);
    process.env.DEMO_MODE = "true";
    resetServerEnvCache();
    expect((await view(d.ref, d.buyer)).actions).toContain("simulate_delivery");
    const res = await simulateRoute(req("POST", {}, as(d.buyer)), ctx(d.ref));
    expect(await res.json()).toMatchObject({ result: { to: "DELIVERED" } });
  });
});

describe("evidence", () => {
  const upload = (ref: string, token: string, bytes: Buffer, caption?: string) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)]), "p.png");
    if (caption) form.set("caption", caption);
    return photosRoute(
      new Request("http://localhost/x", { method: "POST", headers: as(token), body: form }),
      ctx(ref),
    );
  };

  it("either party adds notes and photos while money is held; photos need the party's token", async () => {
    const d = await heldDeal({ ship: true });
    expect(
      (await evidenceRoute(req("POST", { note: "Box arrived crushed" }, as(d.buyer)), ctx(d.ref)))
        .status,
    ).toBe(201);
    const added = await upload(d.ref, d.seller, PNG, "Packed with bubble wrap");
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };

    const v = await view(d.ref, d.buyer);
    expect(v.evidence.map((e) => [e.type, e.addedBy])).toEqual([
      ["tracking", "seller"],
      ["note", "buyer"],
      ["photo", "seller"],
    ]);
    const photo = await photoRoute(
      new Request(`http://localhost/x?t=${encodeURIComponent(d.buyer)}`),
      { params: Promise.resolve({ ref: d.ref, id }) },
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (
        await photoRoute(new Request("http://localhost/x?t=wrong"), {
          params: Promise.resolve({ ref: d.ref, id }),
        })
      ).status,
    ).toBe(404);
  });

  it("refuses files that are not images, and evidence before payment", async () => {
    const d = await heldDeal({ ship: true });
    const res = await upload(d.ref, d.buyer, Buffer.from("<script>alert(1)</script>"));
    expect(res.status).toBe(409);
    expect(await db.select().from(evidenceFiles)).toEqual([]);

    const created = await createDealRoute(
      req("POST", { sellerName: "D", buyerName: "S", terms: TERMS_INPUT }),
    );
    const { ref, links } = (await created.json()) as { ref: string; links: { buyer: string } };
    const buyer = decodeURIComponent(new URL(links.buyer).searchParams.get("t") as string);
    expect(
      (await evidenceRoute(req("POST", { note: "too early" }, as(buyer)), ctx(ref))).status,
    ).toBe(409);
  });
});

describe("extend delivery date", () => {
  it("one party proposes, the other accepts, and a new terms version is in force", async () => {
    const d = await heldDeal({ ship: true });
    const newDate = new Date(Date.now() + 10 * D).toISOString();
    await extendRoute(
      req("POST", { action: "propose", newDeliverBy: newDate }, as(d.seller)),
      ctx(d.ref),
    );
    const buyer = await view(d.ref, d.buyer);
    expect(buyer.actions).toContain("decide_extension");
    expect(buyer.extension).toMatchObject({ proposedBy: "seller" });
    expect((await view(d.ref, d.seller)).actions).not.toContain("decide_extension");

    const res = await extendRoute(
      req("POST", { action: "accept", extensionId: buyer.extension?.id }, as(d.buyer)),
      ctx(d.ref),
    );
    expect(res.status).toBe(200);
    const after = await view(d.ref, d.seller);
    expect(after.termsVersion).toBe(2);
    expect(after.extension).toBeNull();
  });
});

describe("reviewer", () => {
  async function login() {
    const res = await adminLoginRoute(req("POST", { password: "test-admin-password" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") as string;
    expect(cookie).toContain("HttpOnly");
    return { cookie: cookie.split(";")[0] };
  }

  it("needs the password, then decides with a written reason through the engine", async () => {
    expect((await adminLoginRoute(req("POST", { password: "nope" }))).status).toBe(401);
    const d = await heldDeal({ ship: true });
    await receiptRoute(
      req("POST", { action: "problem", note: "Wrong model" }, as(d.buyer)),
      ctx(d.ref),
    );
    expect(await state(d.id)).toBe("IN_REVIEW");

    const body = { decision: "void", reason: "Seller sent an A05, not the agreed A15." };
    expect((await adminDecisionRoute(req("POST", body), ctx(d.ref))).status).toBe(401);
    const { cookie } = await login();
    expect(
      (
        await adminDecisionRoute(
          new Request("http://localhost/x", {
            method: "POST",
            headers: { cookie, "content-type": "text/plain" },
            body: JSON.stringify(body),
          }),
          ctx(d.ref),
        )
      ).status,
    ).toBe(415);
    expect(
      (await adminDecisionRoute(req("POST", { ...body, reason: "no" }, { cookie }), ctx(d.ref)))
        .status,
    ).toBe(400);
    const res = await adminDecisionRoute(req("POST", body, { cookie }), ctx(d.ref));
    expect(await res.json()).toMatchObject({ outcome: "moved", to: "VOIDED" });
    expect(fake.port.voidAuth).toHaveBeenCalledTimes(1);
  });

  it("the AI check stores advice and changes nothing", async () => {
    const d = await heldDeal({ ship: true });
    await receiptRoute(
      req("POST", { action: "problem", note: "Screen cracked" }, as(d.buyer)),
      ctx(d.ref),
    );
    const { cookie } = await login();
    const model = fakeModel([
      {
        label: "uncertain",
        reasons: ["[e1] tracking only shows the parcel was sent", "No photo of the screen"],
        instruction_flags: [],
      },
    ]);
    setEvidenceModel(model.call);
    const res = await adminCheckRoute(req("POST", {}, { cookie }), ctx(d.ref));
    expect(await res.json()).toMatchObject({ label: "uncertain" });
    expect(await db.select().from(evidenceChecks)).toHaveLength(1);
    expect(await state(d.id)).toBe("IN_REVIEW");
    // The buyer's note reaches the model as untrusted evidence, not as an instruction.
    expect(JSON.stringify(model.seen[0].messages)).toContain("<note>Screen cracked</note>");
  });

  it("admin photos need the admin cookie", async () => {
    const d = await heldDeal({ ship: true });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(PNG)]), "p.png");
    const { id } = (await (
      await photosRoute(
        new Request("http://localhost/x", { method: "POST", headers: as(d.buyer), body: form }),
        ctx(d.ref),
      )
    ).json()) as { id: string };
    const p = { params: Promise.resolve({ ref: d.ref, id }) };
    expect((await adminPhotoRoute(new Request("http://localhost/x"), p)).status).toBe(401);
    const { cookie } = await login();
    expect(
      (await adminPhotoRoute(new Request("http://localhost/x", { headers: { cookie } }), p)).status,
    ).toBe(200);
  });
});

describe("evidence bundle", () => {
  it("is available once paid, and leaves out the reviewer's AI advice", async () => {
    const d = await heldDeal({ ship: true });
    expect((await bundleRoute(req("GET", undefined, as(d.seller)), ctx(d.ref))).status).toBe(409);
    await receiptRoute(req("POST", { action: "confirm" }, as(d.buyer)), ctx(d.ref));
    const res = await bundleRoute(req("GET", undefined, as(d.seller)), ctx(d.ref));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bundle = (await res.json()) as Record<string, unknown>;
    expect(bundle).toMatchObject({ state: "CAPTURED", ref: d.ref });
    expect(bundle).not.toHaveProperty("checks");
    expect((bundle.audit as unknown[]).length).toBeGreaterThan(3);
  });
});

vi.setConfig({ testTimeout: 20_000 });
