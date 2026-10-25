import { MAX_CHAT_CHARS, MAX_MESSAGES } from "./chat";

// An exported chat file → chat text the AI reads (runs in the browser; the file never leaves the
// seller's phone, only the text does, through the usual redaction in /api/extract).
// WhatsApp: .txt, or the .zip iPhones make (with `_chat.txt`). Instagram and Facebook: the
// `message_1.json` files of "Download your information", or their .zip. Telegram: `result.json`
// from "Export chat history" as JSON. Everything becomes one line per message in WhatsApp's
// Android format, day first and 24-hour, which `parseChat` reads with times and names.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type ChatFile =
  | {
      ok: true;
      text: string;
      source: "WhatsApp" | "Instagram" | "Telegram" | "Text";
      /** Messages in the file, and how many of the latest ones fit what the AI reads. */
      total: number;
      kept: number;
      /** Dates (YYYY-MM-DD) of the first and last message kept, when the export has them. */
      from: string | null;
      to: string | null;
    }
  | { ok: false; reason: string };

type Line = { at: Date | LocalTime | null; from: string | null; text: string };
type LocalTime = { y: number; mo: number; d: number; h: number; mi: number };

const UNREADABLE =
  "SafeDeal could not find a chat in that file. Upload the .txt or .zip from WhatsApp's Export chat, or an Instagram or Telegram JSON export.";

export async function chatFromFile(name: string, bytes: Uint8Array): Promise<ChatFile> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: "That file is too big. Export the chat without media." };
  }
  const files = /\.zip$/i.test(name) || isZip(bytes) ? await unzip(bytes) : [{ name, bytes }];
  if (!files) return { ok: false, reason: UNREADABLE };

  const json = files.filter((f) => /\.json$/i.test(f.name));
  const txt = files.filter((f) => /\.txt$/i.test(f.name));
  let parsed: { source: "WhatsApp" | "Instagram" | "Telegram" | "Text"; lines: Line[] } | null =
    null;
  if (json.length) parsed = fromJson(json.map((f) => decode(f.bytes)));
  if (!parsed && txt.length) {
    // WhatsApp names it `_chat.txt` (iPhone) or "WhatsApp Chat with …" (Android).
    const main =
      txt.find((f) => /(^|\/)_chat\.txt$/i.test(f.name)) ??
      txt.find((f) => /whatsapp/i.test(f.name)) ??
      [...txt].sort((a, b) => b.bytes.byteLength - a.bytes.byteLength)[0];
    parsed = fromText(decode(main.bytes));
  }
  if (!parsed || !parsed.lines.length) return { ok: false, reason: UNREADABLE };
  return fit(parsed.source, parsed.lines);
}

// ---------------------------------------------------------------------------------------------
// Files

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function unzip(bytes: Uint8Array) {
  const { unzipSync } = await import("fflate");
  try {
    // Only chat files, and only sensible sizes (a tiny zip can claim to unpack to gigabytes).
    const out = unzipSync(bytes, {
      filter: (f) => /\.(txt|json)$/i.test(f.name) && f.originalSize <= MAX_FILE_BYTES,
    });
    return Object.entries(out).map(([n, b]) => ({ name: n, bytes: b }));
  } catch {
    return null;
  }
}

const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b).replace(/^﻿/, "");

// ---------------------------------------------------------------------------------------------
// WhatsApp text

// [20/10/2026, 09:01:22] Name: text  ·  20/10/2026, 9:01 pm - Name: text  ·  10/20/26, 21:01 - …
const HEAD =
  /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([ap])?\.?\s*m?\.?\]?\s*(?:-\s*)?(.*)$/i;
const SENDER = /^([^:]{1,60}):\s?([\s\S]*)$/;
const DIRECTION = /[‎‏‪-‮]/g;
// Placeholders that say nothing about the deal.
const NOISE =
  /^(<media omitted>|(image|video|audio|sticker|gif|document|contact card) omitted|this message was deleted|you deleted this message|null|<attached: [^>]*>|missed (voice|video) call)$/i;

function fromText(raw: string): { source: "WhatsApp" | "Text"; lines: Line[] } {
  const rows = raw.replace(/\r\n?/g, "\n").replace(DIRECTION, "").split("\n");
  // Day or month first? A first number above 12 means day first; a second one means month first.
  let dayFirst = 0;
  let monthFirst = 0;
  for (const r of rows) {
    const h = HEAD.exec(r);
    if (!h) continue;
    if (Number(h[1]) > 12) dayFirst++;
    if (Number(h[2]) > 12) monthFirst++;
  }
  const swap = monthFirst > dayFirst;

  const lines: Line[] = [];
  let structured = false;
  for (const r of rows) {
    const h = HEAD.exec(r);
    if (h) {
      structured = true;
      const [, a, b, y, hh, mm, ampm, rest] = h;
      const sender = SENDER.exec(rest);
      // "Messages and calls are end-to-end encrypted", "X added Y": no sender, not a message.
      if (!sender) continue;
      let hour = Number(hh) % (ampm ? 12 : 24);
      if (ampm?.toLowerCase() === "p") hour += 12;
      const at: LocalTime = {
        y: y.length === 2 ? 2000 + Number(y) : Number(y),
        mo: Number(swap ? a : b),
        d: Number(swap ? b : a),
        h: hour,
        mi: Number(mm),
      };
      lines.push({ at, from: sender[1].trim(), text: sender[2].trim() });
    } else if (structured && lines.length) {
      if (r.trim()) lines[lines.length - 1].text += `\n${r.trim()}`;
    } else if (r.trim()) {
      lines.push({ at: null, from: null, text: r.trim() });
    }
  }
  return { source: structured ? "WhatsApp" : "Text", lines: clean(lines) };
}

// ---------------------------------------------------------------------------------------------
// Instagram, Facebook and Telegram JSON

type Insta = { sender_name?: string; timestamp_ms?: number; content?: string };
type Tg = { from?: string; date?: string; text?: string | (string | { text?: string })[] };

function fromJson(texts: string[]): { source: "Instagram" | "Telegram"; lines: Line[] } | null {
  const insta: Line[] = [];
  const tg: Line[] = [];
  for (const t of texts) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      continue;
    }
    const messages = (data as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages as (Insta & Tg)[]) {
      if (typeof m.timestamp_ms === "number" && m.sender_name) {
        if (typeof m.content !== "string") continue;
        insta.push({
          at: new Date(m.timestamp_ms),
          from: mojibake(m.sender_name),
          text: mojibake(m.content),
        });
      } else if (typeof m.date === "string" && m.from) {
        const text =
          typeof m.text === "string"
            ? m.text
            : (m.text ?? []).map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("");
        const d = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(m.date);
        if (!text.trim() || !d) continue;
        const [, y, mo, day, h, mi] = d.map(Number);
        tg.push({ at: { y, mo, d: day, h, mi }, from: m.from, text });
      }
    }
  }
  if (insta.length) {
    // Instagram lists newest first, possibly over several files.
    insta.sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
    return { source: "Instagram", lines: clean(insta) };
  }
  return tg.length ? { source: "Telegram", lines: clean(tg) } : null;
}

/** Instagram writes UTF-8 bytes as if each were a character ("Ã©" for "é", emoji as "ð\x9f…"). */
function mojibake(s: string): string {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const fixed = new TextDecoder("utf-8").decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  return fixed.includes("�") ? s : fixed;
}

// ---------------------------------------------------------------------------------------------
// Output

function clean(lines: Line[]): Line[] {
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s*<this message was edited>$/i, "").trim() }))
    .filter((l) => l.text && !NOISE.test(l.text));
}

const NAIROBI = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function local(at: Line["at"]): LocalTime | null {
  if (!at) return null;
  if (!(at instanceof Date)) return at;
  const p = Object.fromEntries(NAIROBI.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

const pad = (n: number) => String(n).padStart(2, "0");

function render(l: Line): string {
  const t = local(l.at);
  // Names cannot contain ":" or start a fake header line.
  const from = (l.from ?? "").replace(/:/g, " ").trim();
  if (!t || !from) return l.text;
  return `${pad(t.d)}/${pad(t.mo)}/${t.y}, ${pad(t.h)}:${pad(t.mi)} - ${from}: ${l.text}`;
}

/** Keep the latest messages that fit what the AI reads: the deal is agreed at the end. */
function fit(source: "WhatsApp" | "Instagram" | "Telegram" | "Text", lines: Line[]): ChatFile {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_MESSAGES; i--) {
    const r = render(lines[i]);
    if (size + r.length + 1 > MAX_CHAT_CHARS) {
      // A single huge last message: keep its end rather than nothing.
      if (!out.length) out.unshift(r.slice(-MAX_CHAT_CHARS));
      break;
    }
    out.unshift(r);
    size += r.length + 1;
  }
  const kept = lines.slice(lines.length - out.length);
  const day = (l?: Line) => {
    const t = local(l?.at ?? null);
    return t ? `${t.y}-${pad(t.mo)}-${pad(t.d)}` : null;
  };
  return {
    ok: true,
    text: out.join("\n"),
    source,
    total: lines.length,
    kept: out.length,
    from: day(kept[0]),
    to: day(kept[kept.length - 1]),
  };
}
