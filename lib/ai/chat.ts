import { neutralise } from "./untrusted";

// Split a pasted chat (WhatsApp export or plain lines) into numbered messages [m1], [m2] … so the
// AI can cite which message each deal field came from, and the Deal Room can show that message.

export type ChatMessage = { id: string; at: string | null; from: string | null; text: string };

export const MAX_CHAT_CHARS = 15_000;
export const MAX_MESSAGES = 300;

// iOS:     [20/10/2026, 09:01] Name: text      (seconds optional)
// Android: 20/10/2026, 09:01 - Name: text
const IOS =
  /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::\d{2})?(?:\s?[ap]m)?\] ([^:]{1,60}): ?(.*)$/i;
const ANDROID =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?:\s?[ap]m)? - ([^:]{1,60}): ?(.*)$/i;

/** Day-first dates, as in Kenyan WhatsApp exports. Returns "YYYY-MM-DDTHH:MM" (Nairobi local). */
function stamp(d: string, m: string, y: string, hh: string, mm: string): string | null {
  const year = y.length === 2 ? `20${y}` : y;
  const day = Number(d);
  const month = Number(m);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n: number | string) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hh)}:${mm}`;
}

export function parseChat(raw: string): ChatMessage[] {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .split("\n");
  const out: Omit<ChatMessage, "id">[] = [];
  let structured = false;
  for (const line of lines) {
    const hit = IOS.exec(line) ?? ANDROID.exec(line);
    if (hit) {
      structured = true;
      const [, d, m, y, hh, mm, from, text] = hit;
      out.push({ at: stamp(d, m, y, hh, mm), from: from.trim(), text: text.trim() });
    } else if (structured && out.length && line.trim()) {
      // A continuation line of a multi-line message.
      out[out.length - 1].text += `\n${line.trim()}`;
    } else if (line.trim()) {
      out.push({ at: null, from: null, text: line.trim() });
    }
  }
  return out.slice(0, MAX_MESSAGES).map((msg, i) => ({ id: `m${i + 1}`, ...msg }));
}

/** The chat as the AI sees it: one message per entry, prefixed with its id. */
export function formatForModel(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const head = [m.at && `(${m.at.replace("T", " ")})`, m.from && `${m.from}:`]
        .filter(Boolean)
        .join(" ");
      // Continuation lines are indented, so only SafeDeal's own lines start with "[m…]".
      const text = neutralise(m.text).replace(/\n/g, "\n    ");
      return `[${m.id}] ${head ? `${head} ` : ""}${text}`;
    })
    .join("\n");
}

/** The date the chat starts (YYYY-MM-DD), if the export has timestamps. */
export function chatStartDate(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.at);
  return first?.at?.slice(0, 10) ?? null;
}
