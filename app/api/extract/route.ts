import { z } from "zod";
import { MAX_CHAT_CHARS } from "@/lib/ai/chat";
import { clientKey, perClient, perDay } from "@/lib/ai/rate-limit";
import { extractModel, readChat } from "@/lib/ai/service";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail, json, readJson } from "@/lib/http";

const body = z.object({
  chat: z.string().trim().min(1).max(MAX_CHAT_CHARS),
  chatDate: z.iso.date().nullish(),
});

/** Seller pastes a chat; the AI proposes deal terms with sources. Nothing is created yet. */
export async function POST(req: Request) {
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const env = serverEnv();
  const call = extractModel(env);
  if (!call) {
    return fail(503, "Reading chats is not set up on this server. Fill in the form by hand.");
  }
  const now = Date.now();
  if (!perClient.take(clientKey(req), now) || !perDay.take("all", now)) {
    return fail(429, "Too many chats read in a short time. Wait a few minutes or fill in by hand.");
  }
  const result = await readChat(
    getDb(),
    { chat: input.data.chat, chatDate: input.data.chatDate, now: new Date(now) },
    {
      call,
      modelName: env.LLM_MODEL,
      kesPerUsd: env.KES_PER_USD,
    },
  );
  return json(result);
}
