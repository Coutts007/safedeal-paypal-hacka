import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { TINY_PNG_BASE64 } from "@/lib/ai/injection-cases";
import {
  bundleBlocks,
  bundlePdf,
  describeAudit,
  pdfSafe,
  summary,
  type BundleInput,
} from "./bundle";

const at = (s: string) => `2026-10-${s}:00.000Z`;
const audit = (
  i: number,
  when: string,
  actor: string,
  action: string,
  details: Record<string, unknown>,
) => ({ id: i, at: at(when), actor, action, details, hash: `hash${i}`.padEnd(12, "0") });

/** A deal paid, shipped by G4S, delivered by courier and confirmed by the buyer. */
function captured(over: Partial<BundleInput> = {}): BundleInput {
  return {
    ref: "AB12CD34EF",
    state: "CAPTURED",
    names: { seller: "David", buyer: "Shemaya" },
    amount: "95.00",
    payeeEmail: "seller@example.com",
    terms: {
      item: "Samsung Galaxy A15, used (6 months)",
      quantity: 1,
      price: { amount: "95.00", currency: "USD" },
      deliveryMethod: "courier",
      carrier: "G4S",
      shipBy: null,
      deliverBy: null,
      inspectionHours: 48,
      conditions: ["Screen has no cracks"],
      payeeEmail: "seller@example.com",
    },
    termsVersion: 1,
    termsVersions: 1,
    chat: [
      { id: "m1", at: "20/10/2026, 10:02", from: "Shemaya", text: "Is the A15 available? 🙏" },
    ],
    chatFlags: [{ messageId: "m5", reason: "asks to release the funds" }],
    deadlines: {
      shipBy: at("22T07:00"),
      deliverBy: at("27T07:00"),
      inspectionEndsAt: null,
      reviewAt: null,
      holdEndsAt: at("29T07:00"),
      authorizedAt: at("20T07:00"),
    },
    honourPeriodPassed: false,
    handover: {
      deliveryProof: "courier",
      deliveredAt: at("21T09:00"),
      attempts: 0,
      locked: false,
      hasCode: true,
    },
    payments: [
      {
        attempt: 1,
        orderId: "ORD-1",
        authorizationId: "AUTH-1",
        captureId: "CAP-1",
        status: "CAPTURED",
      },
    ],
    evidence: [
      {
        id: "e1",
        type: "tracking",
        addedBy: "seller",
        carrier: "G4S",
        trackingNumber: "G4S-777",
        note: null,
        createdAt: at("20T12:00"),
      },
      {
        id: "e2",
        type: "photo",
        addedBy: "seller",
        carrier: null,
        trackingNumber: null,
        note: "Packed phone",
        createdAt: at("20T12:05"),
      },
    ],
    courierEvents: [
      {
        eventId: "c1",
        status: "DELIVERED",
        trackingNumber: "G4S-777",
        verified: true,
        receivedAt: at("21T09:00"),
      },
    ],
    reviews: [],
    extensions: [],
    audit: [
      audit(1, "20T06:00", "seller", "deal.created", { termsVersion: 1, fromChat: true }),
      audit(2, "20T06:10", "seller", "trigger.accepted", {
        trigger: "CONFIRM",
        reason: "waiting for the other party to confirm these terms",
      }),
      audit(3, "20T06:20", "buyer", "state.changed", {
        trigger: "CONFIRM",
        from: "DRAFT",
        to: "AGREED",
        reason: "both parties confirmed the same terms",
      }),
      audit(4, "20T07:00", "buyer", "state.changed", {
        from: "AGREED",
        to: "AUTHORIZED",
        reason: "buyer approved the payment",
      }),
      audit(5, "20T12:05", "seller", "evidence.added", { type: "photo", sha256: "ab".repeat(32) }),
      audit(6, "21T10:00", "buyer", "state.changed", {
        from: "DELIVERED",
        to: "CAPTURED",
        reason: "buyer confirmed receipt",
      }),
    ],
    chainOk: true,
    generatedAt: new Date(at("24T19:20")),
    photos: [
      {
        evidenceId: "e2",
        contentType: "image/png",
        sha256: "ab".repeat(32),
        sizeBytes: 68,
        data: Buffer.from(TINY_PNG_BASE64, "base64"),
      },
    ],
    ...over,
  };
}

const allText = (b: BundleInput) =>
  bundleBlocks(b)
    .map((x) => JSON.stringify(x))
    .join("\n");

describe("evidence bundle content", () => {
  it("tells the story of the deal in plain sentences, in Nairobi time", () => {
    const s = summary(captured()).join(" ");
    expect(s).toContain(
      "Shemaya agreed to buy Samsung Galaxy A15, used (6 months) from David for US$95.00.",
    );
    expect(s).toContain("Shemaya paid with PayPal on 20 Oct 2026, 10:00.");
    expect(s).toContain("David added G4S tracking number G4S-777");
    expect(s).toContain("proven by a signed delivery event from the courier");
    expect(s).toContain(
      "Shemaya confirmed receiving the item, so PayPal paid David on 21 Oct 2026, 13:00.",
    );
    expect(s).toContain("Status when this document was made: Seller paid.");
  });

  it("explains how the seller was paid when the inspection time ended or a reviewer decided", () => {
    const by = (actor: string) =>
      summary(
        captured({
          audit: [
            audit(1, "21T10:00", actor, "state.changed", { from: "DELIVERED", to: "CAPTURED" }),
          ],
        }),
      ).join(" ");
    expect(by("sweep")).toContain("48-hour inspection time after delivery ended with no problem");
    expect(by("admin")).toContain("A SafeDeal reviewer decided the seller should be paid");
  });

  it("describes timeline entries in words, not codes", () => {
    const b = captured();
    expect(describeAudit(b.audit[3])).toBe(
      "Buyer approved the payment. Now: Paid, money held by PayPal",
    );
    expect(describeAudit(b.audit[1])).toMatch(/^Confirmed the terms/);
    expect(
      describeAudit(
        audit(9, "22T00:00", "seller", "trigger.rejected", {
          reason: "the ship-by deadline has passed",
        }),
      ),
    ).toBe("Not accepted: the ship-by deadline has passed");
    const text = allText(b);
    expect(text).toContain("Shemaya (buyer)");
    expect(text).toContain("Paid to the seller");
    expect(text).toContain("Courier, G4S");
    expect(text).not.toMatch(/"state\.changed"|"trigger\.accepted"|AUTHORIZED|CAPTURED/);
  });

  it("includes problems, reviewer decisions, the chat and its ignored instructions; not the AI's advice", () => {
    const text = allText(
      captured({
        reviews: [
          {
            kind: "buyer_problem",
            reason: "buyer reported a problem",
            note: "Screen is cracked",
            decision: "capture",
            decidedBy: "admin",
            createdAt: at("21T11:00"),
            decidedAt: at("22T08:00"),
          },
        ],
      }),
    );
    expect(text).toContain('Shemaya reported a problem: \\"Screen is cracked\\"');
    expect(text).toContain("Pay the seller");
    expect(text).toContain("Is the A15 available?");
    expect(text).toContain("Message m5 looked like an instruction and was ignored");
    expect(text).toContain("Photo from David (seller)");
    expect(text).toContain(`SHA-256 fingerprint: ${"ab".repeat(32)}`);
    expect(text).not.toContain("checks");
  });

  it("shows only the message column for a chat pasted without times or names", () => {
    const tables = (b: BundleInput) =>
      bundleBlocks(b).filter((x) => x.kind === "table" && x.columns.at(-1)?.title === "Message");
    const bare = captured({ chat: [{ id: "m1", at: null, from: null, text: "Nipee best price" }] });
    expect(tables(bare)).toEqual([
      { kind: "table", columns: [{ title: "Message", width: 1 }], rows: [["Nipee best price"]] },
    ]);
    expect(tables(captured())[0]).toMatchObject({
      rows: [["20/10/2026, 10:02", "Shemaya", expect.any(String)]],
    });
  });

  it("says when the tamper-evident log check failed", () => {
    expect(allText(captured({ chainOk: false }))).toContain("the check of the whole log FAILED");
    expect(allText(captured())).toContain("the check of the whole log passed");
  });
});

describe("evidence bundle PDF", () => {
  it("is a valid PDF with a title, page numbers and the photo embedded", async () => {
    const bytes = await bundlePdf(captured());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("SafeDeal evidence bundle, deal AB12CD34EF");
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(bytes).toString("latin1")).toContain("/Subtype /Image");
  });

  it("builds with emoji, other scripts, very long words and a long chat, over several pages", async () => {
    const chat = Array.from({ length: 120 }, (_, i) => ({
      id: `m${i + 1}`,
      at: null,
      from: "David",
      text: `Message ${i} 😀 ✅ → नमस्ते ${"x".repeat(i % 7 === 0 ? 300 : 3)}`,
    }));
    const doc = await PDFDocument.load(await bundlePdf(captured({ chat })));
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });

  it("lists a WebP photo by fingerprint instead of failing", async () => {
    const b = captured();
    b.photos[0] = { ...b.photos[0], contentType: "image/webp", data: Buffer.from("RIFF0000WEBP") };
    await expect(bundlePdf(b)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("replaces characters the PDF font cannot draw", () => {
    expect(pdfSafe("Sawa → kesho 🙏 ‹ok› café")).toBe("Sawa -> kesho ? ‹ok› café");
  });
});
