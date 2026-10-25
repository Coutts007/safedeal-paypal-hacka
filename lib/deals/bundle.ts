import {
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { AdminDealView } from "@/lib/admin/queries";
import type { DealState } from "@/lib/db/schema";

// The dispute evidence bundle (section 7.1) as a document people can read: what was agreed, how
// the money was held and released, shipping and delivery, the parties' evidence, reviews, the
// full timeline and the chat. A PDF, because PayPal's Resolution Center accepts PDF uploads.
// `bundleBlocks` decides the content (tested); `bundlePdf` only lays it out.

export type BundlePhoto = {
  evidenceId: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  data: Uint8Array;
};

/** The reviewer's deal view without the reviewer-only fields (AI advice, decide button). */
export type BundleRecord = Omit<AdminDealView, "checks" | "canDecide">;
export type BundleInput = BundleRecord & {
  generatedAt: Date;
  photos: BundlePhoto[];
};

export type Block =
  | { kind: "title"; text: string; sub: string }
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "facts"; rows: [string, string][] }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; columns: { title: string; width: number }[]; rows: string[][] }
  | { kind: "photo"; evidenceId: string; caption: string };

const DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
/** Nairobi time with the year, e.g. "24 Oct 2026, 22:20". */
export const when = (d: Date | string | null | undefined) => (d ? DATE.format(new Date(d)) : "-");

export const STATE_LABEL: Record<DealState, string> = {
  DRAFT: "Draft",
  AGREED: "Agreed, waiting for payment",
  AUTHORIZED: "Paid, money held by PayPal",
  FUNDING_FAILED: "Payment did not go through",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  IN_REVIEW: "With a SafeDeal reviewer",
  CAPTURED: "Seller paid",
  CAPTURE_FAILED: "Paying the seller failed",
  VOIDED: "Hold released to the buyer",
  EXPIRED: "PayPal's hold expired",
  DISPUTED: "PayPal dispute open",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
const stateLabel = (s: unknown) => STATE_LABEL[s as DealState] ?? String(s);

const DELIVERY: Record<string, string> = {
  courier: "Courier",
  rider: "Rider (boda or delivery rider)",
  pickup: "Pickup in person",
  post: "Post",
  other: "Other",
};

const REVIEW_KIND: Record<string, string> = {
  deliver_by: "Delivery date passed without proof of delivery",
  day_26: "Day 26 of PayPal's hold with no decision",
  buyer_problem: "The buyer reported a problem",
  paypal: "A PayPal problem",
  other: "Other",
};

const REVIEW_DECISION: Record<string, string> = {
  capture: "Pay the seller",
  void: "Release the hold to the buyer",
  cleared: "Settled without a reviewer (late confirmation or delivery)",
};

const PROOF: Record<string, string> = {
  courier: "a signed delivery event from the courier, verified by SafeDeal",
  handover_code: "the buyer's handover code, entered by the seller at handover",
  buyer: "the buyer's own confirmation",
};

function paymentStatus(s: string) {
  if (s.startsWith("AUTHORIZE_FAILED"))
    return `Refused by PayPal (${s.split(":")[1] ?? "no reason"})`;
  const map: Record<string, string> = {
    PAYER_ACTION_REQUIRED: "Not paid",
    APPROVED: "Approved by the buyer",
    CREATED: "Money held (authorised)",
    PENDING: "Pending at PayPal",
    CAPTURED: "Paid to the seller",
    COMPLETED: "Paid to the seller",
    VOIDED: "Hold released to the buyer",
    EXPIRED: "Hold expired",
  };
  return map[s] ?? s;
}

const sentence = (s: unknown) => {
  const t = String(s ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};
const usd = (a: string | null | undefined) => (a ? `US$${a}` : "-");

type AuditRow = BundleInput["audit"][number];

function actorName(b: BundleInput, actor: string) {
  const seller = b.names.seller ?? "The seller";
  const buyer = b.names.buyer ?? "The buyer";
  const map: Record<string, string> = {
    seller: `${seller} (seller)`,
    buyer: `${buyer} (buyer)`,
    sweep: "SafeDeal (automatic check)",
    system: "SafeDeal",
    admin: "SafeDeal reviewer",
    paypal: "PayPal",
    courier: "Courier",
  };
  return map[actor] ?? actor;
}

/** One audit entry in plain words. */
export function describeAudit(a: AuditRow): string {
  const x = a.details;
  const why = sentence(x.reason);
  switch (a.action) {
    case "deal.created":
      return x.fromChat ? "Created the deal from a pasted chat" : "Created the deal";
    case "deal.seeded":
      return "Demo deal created";
    case "terms.proposed":
      return `Proposed terms version ${x.version}`;
    case "evidence.added":
      return x.type === "photo"
        ? `Added a photo for the reviewer (fingerprint ${String(x.sha256 ?? "").slice(0, 16)})`
        : "Added a note for the reviewer";
    case "payment.order_created":
      return `Started paying with PayPal (order ${x.orderId})`;
    case "paypal.create_failed":
      return `PayPal could not create the order (${x.issue})`;
    case "paypal.pending":
      return `${why}. PayPal did not answer; SafeDeal retries with the same request`;
    case "paypal.failed":
      return `${why}. The PayPal step failed; now: ${stateLabel(x.to)}`;
    case "state.changed":
      return `${why}. Now: ${stateLabel(x.to)}`;
    case "trigger.accepted":
      return x.trigger === "CONFIRM" ? `Confirmed the terms (${x.reason})` : why;
    case "trigger.rejected":
      return `Not accepted: ${x.reason}`;
    case "handover.locked":
      return "Too many wrong handover codes; code entry locked and a reviewer alerted";
    case "handover.unlocked":
      return `A reviewer unlocked handover code entry${x.adminReason ? `: ${x.adminReason}` : ""}`;
    case "extension.expired":
      return "A proposed new delivery date expired without an answer";
    default:
      return why || a.action;
  }
}

const moveTo = (b: BundleInput, to: DealState) =>
  b.audit.find((a) => a.action === "state.changed" && a.details.to === to);

/** The story of the deal in a few sentences. */
export function summary(b: BundleInput): string[] {
  const seller = b.names.seller ?? "The seller";
  const buyer = b.names.buyer ?? "The buyer";
  const t = b.terms;
  const out: string[] = [];
  const item = t ? `${t.quantity > 1 ? `${t.quantity} x ` : ""}${t.item}` : "the item";
  out.push(`${buyer} agreed to buy ${item} from ${seller} for ${usd(b.amount)}.`);
  const confirmedAt = b.audit.find((a) => a.details.to === "AGREED")?.at;
  if (confirmedAt) {
    out.push(`Both parties confirmed the same terms on SafeDeal on ${when(confirmedAt)}.`);
  }
  if (b.deadlines.authorizedAt) {
    out.push(
      `${buyer} paid with PayPal on ${when(b.deadlines.authorizedAt)}. PayPal held the money; ${seller} could not be paid until delivery was proven.`,
    );
  }
  const tracking = b.evidence.find((e) => e.type === "tracking");
  if (tracking) {
    out.push(
      `${seller} added ${tracking.carrier ? `${tracking.carrier} ` : ""}tracking number ${tracking.trackingNumber ?? "-"} on ${when(tracking.createdAt)}.`,
    );
  }
  if (b.handover.deliveredAt && b.handover.deliveryProof) {
    out.push(
      `Delivery on ${when(b.handover.deliveredAt)} was proven by ${PROOF[b.handover.deliveryProof]}.`,
    );
  }
  for (const r of b.reviews.filter((r) => r.kind === "buyer_problem")) {
    out.push(
      `On ${when(r.createdAt)} ${buyer} reported a problem${r.note ? `: "${r.note}"` : ""}.${r.decision ? ` Reviewer's decision: ${REVIEW_DECISION[r.decision] ?? r.decision}.` : ""}`,
    );
  }
  const captured = moveTo(b, "CAPTURED");
  if (captured) {
    const why: Record<string, string> = {
      buyer: `${buyer} confirmed receiving the item, so `,
      admin: "A SafeDeal reviewer decided the seller should be paid, so ",
      sweep: `The ${b.terms?.inspectionHours ?? 48}-hour inspection time after delivery ended with no problem reported, so `,
    };
    const paid = `PayPal paid ${seller} on ${when(captured.at)}.`;
    out.push(why[captured.actor] ? `${why[captured.actor]}${paid}` : paid);
  }
  const disputed = moveTo(b, "DISPUTED");
  if (disputed) out.push(`${buyer} opened a PayPal dispute on ${when(disputed.at)}.`);
  out.push(`Status when this document was made: ${stateLabel(b.state)}.`);
  return out;
}

/** The document's content, top to bottom. */
export function bundleBlocks(b: BundleInput): Block[] {
  const blocks: Block[] = [];
  const add = (...x: Block[]) => blocks.push(...x);
  const seller = b.names.seller ?? "The seller";
  const buyer = b.names.buyer ?? "The buyer";

  add(
    {
      kind: "title",
      text: "SafeDeal evidence bundle",
      sub: `Deal ${b.ref} · made ${when(b.generatedAt)} · all times are Nairobi time (EAT)`,
    },
    {
      kind: "text",
      muted: true,
      text: "For PayPal's Resolution Center. It shows what both parties agreed, how the payment was held and released, how the item was shipped and delivered, and every step SafeDeal recorded. SafeDeal's AI only helps fill in the deal form; it never decides about money, and its advice is not part of this record.",
    },
    { kind: "heading", text: "Summary" },
    ...summary(b).map((text): Block => ({ kind: "text", text })),
  );

  add({ kind: "heading", text: "What both parties agreed" });
  const t = b.terms;
  if (t) {
    const confirms = b.audit.filter(
      (a) => a.details.trigger === "CONFIRM" && (a.actor === "buyer" || a.actor === "seller"),
    );
    add({
      kind: "facts",
      rows: [
        ["Seller", seller],
        ["Buyer", buyer],
        ["Item", t.item],
        ["Quantity", String(t.quantity)],
        ["Price", usd(t.price.amount)],
        [
          "Delivery",
          `${DELIVERY[t.deliveryMethod] ?? t.deliveryMethod}${t.carrier ? `, ${t.carrier}` : ""}`,
        ],
        ["Ship by", when(b.deadlines.shipBy ?? t.shipBy)],
        ["Deliver by", when(b.deadlines.deliverBy ?? t.deliverBy)],
        [
          "Time to inspect after delivery",
          `${t.inspectionHours} hour${t.inspectionHours === 1 ? "" : "s"}`,
        ],
        ["Seller's PayPal account", t.payeeEmail],
        [
          "Terms version",
          `${b.termsVersion ?? "-"} of ${b.termsVersions}, confirmed by both parties`,
        ],
        ...confirms.map((c): [string, string] => [
          `Confirmed by ${actorName(b, c.actor)}`,
          when(c.at),
        ]),
      ],
    });
    if (t.conditions.length) {
      add({ kind: "text", text: "Conditions agreed:" }, { kind: "bullets", items: t.conditions });
    }
  } else {
    add({ kind: "text", text: "No terms were recorded." });
  }

  add(
    { kind: "heading", text: "PayPal payment" },
    {
      kind: "text",
      muted: true,
      text: "The buyer's payment was authorised (held) by PayPal, not taken. SafeDeal's rule engine asks PayPal to pay the seller only after proof of delivery, and releases the hold if the seller does not ship in time. These ids can be looked up in PayPal.",
    },
  );
  if (b.payments.length) {
    for (const p of b.payments) {
      add({
        kind: "facts",
        rows: [
          ["Payment attempt", String(p.attempt)],
          ["Status", paymentStatus(p.status)],
          ["PayPal order id", p.orderId],
          ["PayPal authorisation id", p.authorizationId ?? "-"],
          ["PayPal capture id", p.captureId ?? "-"],
        ],
      });
    }
  } else {
    add({ kind: "text", text: "No payment was made." });
  }
  add({
    kind: "facts",
    rows: [
      ["Paid (held) on", when(b.deadlines.authorizedAt)],
      ["Last day PayPal holds the money", when(b.deadlines.holdEndsAt)],
    ],
  });

  add({ kind: "heading", text: "Shipping and delivery" });
  const tracking = b.evidence.filter((e) => e.type === "tracking");
  add(
    tracking.length
      ? {
          kind: "table",
          columns: [
            { title: "Added", width: 0.25 },
            { title: "By", width: 0.25 },
            { title: "Carrier", width: 0.2 },
            { title: "Tracking number", width: 0.3 },
          ],
          rows: tracking.map((e) => [
            when(e.createdAt),
            actorName(b, e.addedBy ?? "seller"),
            e.carrier ?? "-",
            e.trackingNumber ?? "-",
          ]),
        }
      : { kind: "text", text: "No tracking number was added." },
  );
  if (b.courierEvents.length) {
    add(
      { kind: "text", text: "Messages from the courier:" },
      {
        kind: "table",
        columns: [
          { title: "Received", width: 0.25 },
          { title: "Status", width: 0.2 },
          { title: "Tracking number", width: 0.3 },
          { title: "Signature", width: 0.25 },
        ],
        rows: b.courierEvents.map((c) => [
          when(c.receivedAt),
          sentence(c.status.toLowerCase().replace(/_/g, " ")),
          c.trackingNumber ?? "-",
          c.verified ? "Verified" : "Not verified (ignored)",
        ]),
      },
    );
  }
  add({
    kind: "facts",
    rows: [
      ["Delivered on", b.handover.deliveredAt ? when(b.handover.deliveredAt) : "Not recorded"],
      [
        "Proof of delivery",
        b.handover.deliveryProof ? sentence(PROOF[b.handover.deliveryProof]) : "None recorded",
      ],
      ["Wrong handover codes entered", String(b.handover.attempts)],
      ...(b.handover.locked ? [["Handover code entry", "Locked"] as [string, string]] : []),
    ],
  });
  for (const x of b.extensions) {
    add({
      kind: "text",
      text: `${when(x.createdAt)}: ${actorName(b, x.proposedBy)} proposed moving the delivery date from ${when(x.oldDeliverBy)} to ${when(x.newDeliverBy)} (${x.status}).`,
    });
  }

  const shared = b.evidence.filter((e) => e.type !== "tracking");
  add({ kind: "heading", text: "Evidence from the buyer and seller" });
  if (!shared.length) add({ kind: "text", text: "Neither party added photos or notes." });
  for (const e of shared) {
    const by = `${actorName(b, e.addedBy ?? "seller")}, ${when(e.createdAt)}`;
    if (e.type === "note") {
      add({ kind: "text", text: `Note from ${by}: "${e.note ?? ""}"` });
      continue;
    }
    const photo = b.photos.find((p) => p.evidenceId === e.id);
    const caption = [
      `Photo from ${by}`,
      e.note ? `Caption: "${e.note}"` : null,
      photo ? `SHA-256 fingerprint: ${photo.sha256}` : "The photo file is missing.",
    ]
      .filter(Boolean)
      .join("\n");
    add({ kind: "photo", evidenceId: e.id, caption });
  }

  add({ kind: "heading", text: "Problems and reviews" });
  if (!b.reviews.length)
    add({ kind: "text", text: "No problem was reported and no review was needed." });
  for (const r of b.reviews) {
    add({
      kind: "facts",
      rows: [
        ["Opened", when(r.createdAt)],
        ["Why", REVIEW_KIND[r.kind] ?? r.kind],
        ...(r.note ? [["What was said", `"${r.note}"`] as [string, string]] : []),
        ["Decision", r.decision ? (REVIEW_DECISION[r.decision] ?? r.decision) : "Not decided yet"],
        ...(r.decidedAt ? [["Decided", when(r.decidedAt)] as [string, string]] : []),
      ],
    });
  }

  add(
    { kind: "heading", text: "Timeline" },
    {
      kind: "text",
      muted: true,
      text: "Every step SafeDeal recorded for this deal, oldest first, including requests the rules did not allow.",
    },
    {
      kind: "table",
      columns: [
        { title: "When", width: 0.22 },
        { title: "Who", width: 0.25 },
        { title: "What happened", width: 0.53 },
      ],
      rows: b.audit.map((a) => [when(a.at), actorName(b, a.actor), describeAudit(a)]),
    },
  );

  if (b.chat.length) {
    add(
      { kind: "heading", text: "The chat the deal was based on" },
      {
        kind: "text",
        muted: true,
        text: "Pasted by the seller when creating the deal, with phone numbers and similar details removed. SafeDeal used it only to suggest the terms above, which both parties then confirmed.",
      },
      chatTable(b.chat),
    );
    if (b.chatFlags.length) {
      add({
        kind: "bullets",
        items: b.chatFlags.map(
          (f) => `Message ${f.messageId} looked like an instruction and was ignored: ${f.reason}`,
        ),
      });
    }
  }

  const last = b.audit.at(-1);
  add(
    { kind: "heading", text: "How to check this record" },
    {
      kind: "text",
      text: `SafeDeal writes every step to a tamper-evident log: each entry carries a fingerprint (hash) of the entry before it, so changing or removing an old entry breaks every later fingerprint. When this document was made, the check of the whole log ${b.chainOk ? "passed" : "FAILED"}.${last ? ` Latest entry fingerprint: ${last.hash}.` : ""}`,
    },
  );
  return blocks;
}

/** The chat as a table; time and sender columns only when the pasted chat had them. */
function chatTable(chat: BundleInput["chat"]): Block {
  const hasAt = chat.some((m) => m.at);
  const hasFrom = chat.some((m) => m.from);
  const side = (hasAt ? 0.2 : 0) + (hasFrom ? 0.18 : 0);
  return {
    kind: "table",
    columns: [
      ...(hasAt ? [{ title: "Sent", width: 0.2 }] : []),
      ...(hasFrom ? [{ title: "From", width: 0.18 }] : []),
      { title: "Message", width: 1 - side },
    ],
    rows: chat.map((m) => [
      ...(hasAt ? [m.at ?? "-"] : []),
      ...(hasFrom ? [m.from ?? "-"] : []),
      m.text,
    ]),
  };
}

// ---- PDF layout --------------------------------------------------------------------------------

// The standard PDF fonts only cover WinAnsi (Latin-1 plus a few marks). Anything else (emoji,
// arrows) is replaced so a chat or note can never make the document fail to build.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfSafe(s: string): string {
  return s
    .replace(/\t/g, " ")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/[‐‑]/g, "-")
    .replace(/[^\n]/gu, (c) => {
      const n = c.codePointAt(0) as number;
      return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || WIN_ANSI_EXTRA.includes(c)
        ? c
        : "?";
    });
}

const PAGE = { w: 595.28, h: 841.89, margin: 48 };
const WIDTH = PAGE.w - 2 * PAGE.margin;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.82, 0.82, 0.85);
const ACCENT = rgb(0.05, 0.3, 0.55);

/** Split text into lines that fit `width`, breaking long words (ids, hashes) too. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let i = w.length - 1;
        while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

class Layout {
  page!: PDFPage;
  y = 0;
  constructor(
    private doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
  }
  /** Make room for `h` points, starting a new page if needed. */
  room(h: number) {
    if (this.y - h < PAGE.margin + 20) this.newPage();
  }
  line(text: string, x: number, size: number, opts: { font?: PDFFont; color?: typeof INK } = {}) {
    this.page.drawText(text, {
      x,
      y: this.y - size,
      size,
      font: opts.font ?? this.font,
      color: opts.color ?? INK,
    });
  }
  paragraph(
    text: string,
    opts: { size?: number; x?: number; width?: number; font?: PDFFont; color?: typeof INK } = {},
  ) {
    const size = opts.size ?? 10;
    const lead = size * 1.4;
    for (const l of wrap(text, opts.font ?? this.font, size, opts.width ?? WIDTH)) {
      this.room(lead);
      this.line(l, opts.x ?? PAGE.margin, size, opts);
      this.y -= lead;
    }
  }
  rule() {
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y },
      end: { x: PAGE.margin + WIDTH, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
  }
  /** Rows of cells; a tall row continues on the next page line by line. */
  table(
    columns: { width: number }[],
    rows: string[][],
    opts: { header?: string[]; labels?: boolean } = {},
  ) {
    const size = 8.5;
    const lead = size * 1.35;
    const pad = 4;
    const xs: number[] = [];
    let x = PAGE.margin;
    for (const c of columns) {
      xs.push(x);
      x += c.width * WIDTH;
    }
    const draw = (cells: string[], font: PDFFont, color = INK) => {
      // Fact tables show their first column (the label) in bold.
      const fontAt = (i: number) => (opts.labels && i === 0 ? this.bold : font);
      const lines = cells.map((c, i) =>
        wrap(c, fontAt(i), size, columns[i].width * WIDTH - pad * 2),
      );
      const n = Math.max(...lines.map((l) => l.length));
      this.room(lead * Math.min(n, 3) + pad);
      this.y -= pad / 2;
      for (let k = 0; k < n; k++) {
        if (this.y - lead < PAGE.margin + 20) {
          this.newPage();
        }
        lines.forEach((l, i) => {
          if (l[k]) {
            this.page.drawText(l[k], {
              x: xs[i] + pad,
              y: this.y - size,
              size,
              font: fontAt(i),
              color,
            });
          }
        });
        this.y -= lead;
      }
      this.y -= pad / 2;
      this.rule();
    };
    if (opts.header) draw(opts.header, this.bold, MUTED);
    for (const r of rows) draw(r, this.font);
    this.y -= 6;
  }
}

/** The bundle as a PDF document. */
export async function bundlePdf(b: BundleInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`SafeDeal evidence bundle, deal ${b.ref}`);
  doc.setAuthor("SafeDeal");
  doc.setCreationDate(b.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const L = new Layout(doc, font, bold);

  for (const block of bundleBlocks(b)) {
    switch (block.kind) {
      case "title":
        L.paragraph(block.text, { size: 20, font: bold, color: ACCENT });
        L.y -= 2;
        L.paragraph(block.sub, { size: 9.5, color: MUTED });
        L.y -= 6;
        break;
      case "heading":
        L.room(50);
        L.y -= 12;
        L.paragraph(block.text, { size: 13, font: bold, color: ACCENT });
        L.rule();
        L.y -= 6;
        break;
      case "text":
        L.paragraph(block.text, { size: block.muted ? 9 : 10, color: block.muted ? MUTED : INK });
        L.y -= 4;
        break;
      case "bullets":
        for (const item of block.items) {
          L.room(14);
          L.line("•", PAGE.margin + 4, 10);
          L.paragraph(item, { x: PAGE.margin + 16, width: WIDTH - 16 });
        }
        L.y -= 4;
        break;
      case "facts":
        L.table([{ width: 0.34 }, { width: 0.66 }], block.rows, { labels: true });
        break;
      case "table":
        L.table(block.columns, block.rows, { header: block.columns.map((c) => c.title) });
        break;
      case "photo": {
        const photo = b.photos.find((p) => p.evidenceId === block.evidenceId);
        let img: PDFImage | null = null;
        try {
          if (photo?.contentType === "image/jpeg") img = await doc.embedJpg(photo.data);
          if (photo?.contentType === "image/png") img = await doc.embedPng(photo.data);
        } catch {
          img = null;
        }
        if (img) {
          const scale = Math.min(1, 260 / img.width, 300 / img.height);
          const w = Math.max(img.width * scale, 24);
          const h = Math.max(img.height * scale, 24);
          L.room(h + 8);
          L.page.drawImage(img, { x: PAGE.margin, y: L.y - h, width: w, height: h });
          L.y -= h + 6;
        }
        const note =
          photo && !img
            ? "\n(This photo's format cannot be shown here; the fingerprint identifies the original file.)"
            : "";
        L.paragraph(block.caption + note, { size: 9 });
        L.y -= 8;
        break;
      }
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const text = pdfSafe(
      `SafeDeal evidence bundle · deal ${b.ref} · page ${i + 1} of ${pages.length}`,
    );
    p.drawText(text, { x: PAGE.margin, y: PAGE.margin - 18, size: 8, font, color: MUTED });
  });
  return doc.save();
}
