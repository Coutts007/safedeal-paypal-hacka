import { getDb } from "@/lib/db";
import { addPhoto, MAX_PHOTO_BYTES } from "@/lib/deals/evidence";
import { fail, json, requireDeal, type RouteCtx } from "@/lib/http";

/** Either party adds a photo (multipart field `file`, optional `caption`) for a reviewer. */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  // Refuse oversized uploads before reading them into memory.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES + 64 * 1024) {
    return fail(413, "the photo is larger than 3 MB");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "send the photo as multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return fail(400, "no photo in the `file` field");
  const caption =
    String(form.get("caption") ?? "")
      .trim()
      .slice(0, 280) || null;
  const added = await addPhoto(getDb(), found.deal.id, found.role, {
    bytes: Buffer.from(await file.arrayBuffer()),
    caption,
  });
  return added.ok
    ? json(added, 201)
    : fail(added.reason.includes("larger") ? 413 : 409, added.reason);
}
