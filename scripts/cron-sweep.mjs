// Render cron job: ask the web service to run the sweep. Needs APP_BASE_URL and CRON_SECRET.
// Exits non-zero on failure so the run shows as failed in the Render dashboard.
const base = process.env.APP_BASE_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error("APP_BASE_URL and CRON_SECRET must be set");
  process.exit(1);
}
const res = await fetch(`${base.replace(/\/$/, "")}/api/cron/sweep`, {
  method: "POST",
  headers: { "x-cron-secret": secret },
  signal: AbortSignal.timeout(120_000),
});
const text = await res.text();
console.log(`sweep HTTP ${res.status}: ${text.slice(0, 2000)}`);
if (!res.ok) process.exit(1);
