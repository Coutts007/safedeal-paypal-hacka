// npm run eval: run the chat extraction on every labelled chat in eval/chats/ and score it field
// by field (precision, recall, F1), overall and per language. Calls the real model (LLM_API_KEY
// and LLM_MODEL from .env), so each full run costs money: about US$1 for 40 chats.
//
//   npm run eval                      all chats
//   npm run eval -- --only en-03,en-19
//   npm run eval -- --limit 5
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  add,
  calibration,
  goldChatSchema,
  metrics,
  SCORED_FIELDS,
  scoreChat,
  ZERO,
  type ChatScore,
  type Counts,
  type GoldChat,
} from "../lib/ai/eval-score";
import { anthropicModel, extractDeal, type AiRunLog } from "../lib/ai/extract";
import { PROMPT_VERSION } from "../lib/ai/prompt";
import type { Extraction } from "../lib/ai/schema";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env: rely on the environment.
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const dir = "eval/chats";
let chats: GoldChat[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "TEMPLATE.json")
  .sort()
  .map((f) => goldChatSchema.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
const only = arg("only")?.split(",");
if (only) chats = chats.filter((c) => only.includes(c.id));
const limit = Number(arg("limit") ?? 0);
if (limit) chats = chats.slice(0, limit);

const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || "claude-sonnet-5-5";
if (!apiKey) {
  console.error("LLM_API_KEY is not set (put it in .env).");
  process.exit(1);
}
const call = anthropicModel({ apiKey, model });

type Row = {
  id: string;
  language: GoldChat["language_mix"];
  status: string;
  score: ChatScore;
  prediction: Extraction | null;
  runs: AiRunLog[];
};

async function runOne(chat: GoldChat): Promise<Row> {
  const runs: AiRunLog[] = [];
  const res = await extractDeal(
    {
      chat: chat.chat,
      chatDate: chat.chat_date,
      now: new Date(`${chat.chat_date}T09:00:00+03:00`),
    },
    { call, modelName: model, log: (r) => void runs.push(r) },
  );
  const prediction = res.ok ? res.extraction : null;
  return {
    id: chat.id,
    language: chat.language_mix,
    status: res.ok ? "ok" : res.reason,
    score: scoreChat(chat, prediction),
    prediction,
    runs,
  };
}

async function runAll(): Promise<Row[]> {
  const done: Row[] = [];
  const queue = [...chats];
  const concurrency = Number(arg("concurrency") ?? 3);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const row = await runOne(c);
        done.push(row);
        console.log(`${row.id}: ${row.status}`);
      }
    }),
  );
  return done.sort((a, b) => a.id.localeCompare(b.id));
}

// The scripts compile to CommonJS, so no top-level await.
void runAll().then(report, (e) => {
  console.error(e);
  process.exit(1);
});

function report(rows: Row[]) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const total = (filter: (r: Row) => boolean, field?: (typeof SCORED_FIELDS)[number]) =>
    rows
      .filter(filter)
      .flatMap((r) =>
        field ? [r.score.fields[field]] : SCORED_FIELDS.map((f) => r.score.fields[f]),
      )
      .reduce<Counts>(add, ZERO);

  console.log(`\nPrompt ${PROMPT_VERSION}, model ${model}, ${rows.length} chats\n`);
  console.log("| Field | Precision | Recall | F1 |\n| --- | --- | --- | --- |");
  const byField = Object.fromEntries(
    SCORED_FIELDS.map((f) => {
      const m = metrics(total(() => true, f));
      console.log(`| ${f} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`);
      return [f, m];
    }),
  );
  const all = metrics(total(() => true));
  console.log(`| **all fields** | ${pct(all.precision)} | ${pct(all.recall)} | ${pct(all.f1)} |`);

  console.log("\n| Language | Chats | Precision | Recall | F1 |\n| --- | --- | --- | --- | --- |");
  const languages = [...new Set(rows.map((r) => r.language))];
  const byLanguage = Object.fromEntries(
    languages.map((l) => {
      const m = metrics(total((r) => r.language === l));
      const n = rows.filter((r) => r.language === l).length;
      console.log(`| ${l} | ${n} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`);
      return [l, { chats: n, ...m }];
    }),
  );

  const calibrated = calibration(rows);
  console.log("\n| AI confidence | Fields filled | Right |\n| --- | --- | --- |");
  for (const [level, c] of Object.entries(calibrated)) {
    console.log(`| ${level} | ${c.filled} | ${c.filled ? pct(c.right / c.filled) : "-"} |`);
  }

  const flagCorrect = rows.filter((r) => r.score.flagCorrect).length;
  const failed = rows.filter((r) => r.status !== "ok").length;
  const tokens = rows
    .flatMap((r) => r.runs)
    .reduce((t, r) => ({ in: t.in + r.inputTokens, out: t.out + r.outputTokens }), {
      in: 0,
      out: 0,
    });
  const latencies = rows.flatMap((r) => r.runs.map((x) => x.latencyMs)).sort((a, b) => a - b);
  console.log(
    `\nInjection flags correct: ${flagCorrect}/${rows.length}. No usable answer: ${failed}.` +
      ` Tokens: ${tokens.in} in, ${tokens.out} out. Median latency ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms.`,
  );

  mkdirSync("eval/results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = `eval/results/${stamp}-${PROMPT_VERSION}.json`;
  writeFileSync(
    out,
    JSON.stringify(
      {
        promptVersion: PROMPT_VERSION,
        model,
        byField,
        all,
        byLanguage,
        calibration: calibrated,
        flagCorrect,
        failed,
        tokens,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`Saved ${out}`);
}
