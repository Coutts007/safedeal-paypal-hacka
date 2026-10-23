import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { deals, evidence, evidenceFiles, type DealState } from "@/lib/db/schema";
import { HELD_STATES } from "@/lib/rules/machine";
import type { Role } from "./service";

// Photos and notes either party adds for a reviewer (BUILD_PLAN Phase 5). Evidence never changes a
// deal's state: only the rule engine does that, and it never reads photos, notes or AI labels.
// Photos are stored in Postgres (no paid file store); the browser shrinks them and strips their
// metadata (e.g. GPS location) before upload.

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTOS_PER_DEAL = 12;
export const MAX_NOTES_PER_DEAL = 30;

/** Evidence can be added while the money is held, and during a PayPal dispute. */
export const EVIDENCE_STATES: readonly DealState[] = [...HELD_STATES, "DISPUTED"];

/** The type from the file's first bytes; the browser's claimed type is not trusted. */
export function imageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

type Added = { ok: true; id: string } | { ok: false; reason: string };

async function lockForEvidence(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  dealId: string,
) {
  const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("no key update");
  if (!deal) return "deal not found";
  if (!EVIDENCE_STATES.includes(deal.state)) {
    return "evidence can be added only while PayPal holds the money";
  }
  return null;
}

export async function addNote(db: Db, dealId: string, role: Role, note: string): Promise<Added> {
  return db.transaction(async (tx) => {
    const problem = await lockForEvidence(tx, dealId);
    if (problem) return { ok: false, reason: problem };
    const [{ n }] = await tx
      .select({ n: count() })
      .from(evidence)
      .where(and(eq(evidence.dealId, dealId), eq(evidence.type, "note")));
    if (n >= MAX_NOTES_PER_DEAL)
      return { ok: false, reason: "this deal has the maximum number of notes" };
    const [row] = await tx
      .insert(evidence)
      .values({ dealId, type: "note", addedBy: role, note })
      .returning({ id: evidence.id });
    // The note text is untrusted and stays out of the audit log.
    await appendAudit(tx, {
      dealId,
      actor: role,
      action: "evidence.added",
      details: { type: "note", evidenceId: row.id },
    });
    return { ok: true, id: row.id };
  });
}

export async function addPhoto(
  db: Db,
  dealId: string,
  role: Role,
  input: { bytes: Buffer; caption: string | null },
): Promise<Added> {
  if (input.bytes.length === 0) return { ok: false, reason: "the photo is empty" };
  if (input.bytes.length > MAX_PHOTO_BYTES)
    return { ok: false, reason: "the photo is larger than 3 MB" };
  const contentType = imageType(input.bytes);
  if (!contentType) return { ok: false, reason: "only JPEG, PNG or WebP photos" };
  return db.transaction(async (tx) => {
    const problem = await lockForEvidence(tx, dealId);
    if (problem) return { ok: false, reason: problem };
    const [{ n }] = await tx
      .select({ n: count() })
      .from(evidence)
      .where(and(eq(evidence.dealId, dealId), eq(evidence.type, "photo")));
    if (n >= MAX_PHOTOS_PER_DEAL) {
      return { ok: false, reason: `a deal can have at most ${MAX_PHOTOS_PER_DEAL} photos` };
    }
    const [row] = await tx
      .insert(evidence)
      .values({ dealId, type: "photo", addedBy: role, note: input.caption })
      .returning({ id: evidence.id });
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    await tx.insert(evidenceFiles).values({
      evidenceId: row.id,
      dealId,
      contentType,
      sizeBytes: input.bytes.length,
      sha256,
      data: input.bytes,
    });
    await appendAudit(tx, {
      dealId,
      actor: role,
      action: "evidence.added",
      details: { type: "photo", evidenceId: row.id, sha256, sizeBytes: input.bytes.length },
    });
    return { ok: true, id: row.id };
  });
}

/** A photo of this deal (null if the id belongs to another deal). */
export async function photoFile(db: Db, dealId: string, evidenceId: string) {
  const [file] = await db
    .select({ contentType: evidenceFiles.contentType, data: evidenceFiles.data })
    .from(evidenceFiles)
    .where(and(eq(evidenceFiles.evidenceId, evidenceId), eq(evidenceFiles.dealId, dealId)));
  return file ?? null;
}

/** Response for a stored photo: never sniffed as anything else, never cached publicly. */
export function photoResponse(file: { contentType: string; data: Buffer }) {
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.data.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
      "Referrer-Policy": "no-referrer",
    },
  });
}
