// Render cron job: ask the web service to run the sweep. Needs APP_BASE_URL and CRON_SECRET.
// Exits non-zero on failure so the run shows as failed in the Render dashboard.
const base = process.env.APP_BASE_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error("APP_BASE_URL and CRON_SECRET must be set");
  process.exit(1);
}
const url = `${base.replace(/\/$/, "")}/api/cron/sweep`;
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "x-cron-secret": secret },
    signal: AbortSignal.timeout(120_000),
  });
} catch (e) {
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
  console.error(`sweep could not reach ${url} (${e instanceof Error ? e.message : e}${cause})`);
  if (/localhost|127\.0\.0\.1/.test(base)) {
    console.error("APP_BASE_URL points to localhost; set it to the web service's https URL.");
  }
  process.exit(1);
}
const text = await res.text();
console.log(`sweep HTTP ${res.status}: ${text.slice(0, 2000)}`);
if (!res.ok) process.exit(1);
