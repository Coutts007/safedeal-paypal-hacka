"use client";

import { useState } from "react";
import type { DealView } from "@/lib/deals/service";
import { Button, Card, Field, inputClass, nairobi, Notice } from "../../components/ui";

// Evidence for a reviewer: tracking, notes and photos from both parties. Both parties and the
// reviewer see everything here. Nothing in it moves money by itself.

const MAX_SIDE = 1600;

/**
 * Shrink a photo in the browser and re-encode it as JPEG. This keeps uploads small on mobile data
 * and drops the photo's metadata, such as the GPS location.
 */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("This photo could not be read"))),
      "image/jpeg",
      0.82,
    ),
  );
}

export function EvidenceList({ view, token }: { view: DealView; token: string }) {
  if (!view.evidence.length) return null;
  const by = (who: string | null) => (who ? `from the ${who}` : "");
  return (
    <Card title="Evidence">
      <ul className="flex flex-col gap-3 text-sm">
        {view.evidence.map((e) => (
          <li key={e.id} className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">
              {nairobi(e.createdAt)} · {e.type === "tracking" ? "tracking" : e.type} {by(e.addedBy)}
            </span>
            {e.type === "tracking" && (
              <span>
                {e.carrier} <span className="font-mono">{e.trackingNumber}</span>
              </span>
            )}
            {e.type === "note" && <span className="whitespace-pre-wrap">{e.note}</span>}
            {e.type === "photo" && e.photoPath && (
              <a
                href={`${e.photoPath}?t=${encodeURIComponent(token)}`}
                target="_blank"
                rel="noreferrer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- private, token-guarded image */}
                <img
                  src={`${e.photoPath}?t=${encodeURIComponent(token)}`}
                  alt={e.note ?? "Evidence photo"}
                  className="max-h-60 rounded-lg border border-neutral-200 object-contain"
                  loading="lazy"
                />
                {e.note && <span className="mt-1 block">{e.note}</span>}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function EvidenceForm({
  view,
  token,
  onAdded,
}: {
  view: DealView;
  token: string;
  onAdded: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function post(path: string, init: RequestInit) {
    const res = await fetch(`/api/deals/${view.ref}/${path}`, {
      method: "POST",
      ...init,
      headers: { "x-deal-token": token, ...(init.headers ?? {}) },
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Could not save it");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (file) {
        const form = new FormData();
        form.set("file", await shrink(file), "photo.jpg");
        if (note.trim()) form.set("caption", note.trim().slice(0, 280));
        await post("photos", { body: form });
      } else {
        await post("evidence", {
          body: JSON.stringify({ note }),
          headers: { "Content-Type": "application/json" },
        });
      }
      setNote("");
      setFile(null);
      setOpen(false);
      setDone(file ? "Photo added." : "Note added.");
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {done && <Notice tone="ok">{done}</Notice>}
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Add a photo or note for the reviewer
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Photo (optional)" hint="The item, the parcel, the label or the damage.">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="text-sm"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Field
        label={file ? "Caption (optional)" : "Note"}
        hint={`${view.role === "buyer" ? "The seller" : "The buyer"} and the reviewer will see this. Do not add phone numbers or codes.`}
      >
        <textarea
          className={`${inputClass} min-h-20`}
          required={!file}
          minLength={file ? 0 : 3}
          maxLength={file ? 280 : 2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy || (!file && note.trim().length < 3)}>
        {busy ? "Saving…" : file ? "Add photo" : "Add note"}
      </Button>
      <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
        Not now
      </Button>
    </form>
  );
}
