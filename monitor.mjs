#!/usr/bin/env node
/**
 * External uptime + DNS monitor for vynly.co.
 * ---------------------------------------------------------------------------
 * Runs on GitHub Actions (external to Vercel) so a Vercel/Vynly outage cannot
 * also take the monitor down. Each run:
 *   1. HTTP check  - GET the site, expect 200 (retries 3x before declaring down,
 *      so a single transient blip doesn't page you).
 *   2. DNS check   - resolve the A record via Google AND Cloudflare DoH; both
 *      must return records. Catches authoritative-DNS / propagation failures.
 *
 * On real failure it: prints a GitHub ::error:: annotation, emails an alert via
 * Resend (if RESEND_API_KEY is set), and exits non-zero so GitHub also sends
 * its built-in workflow-failure notification. Clean runs exit 0 silently.
 *
 * Env:
 *   MONITOR_URL     default https://vynly.co
 *   RESEND_API_KEY  optional - enables the alert email
 *   ALERT_EMAIL     default vovala14@gmail.com
 *   ALERT_FROM      default "Vynly Monitor <vlad@vynly.co>"
 */

const TARGET = process.env.MONITOR_URL || "https://vynly.co";
const HOST = new URL(TARGET).hostname;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "vovala14@gmail.com";
const ALERT_FROM = process.env.ALERT_FROM || "Vynly Monitor <vlad@vynly.co>";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

async function checkHttp() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(TARGET, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "User-Agent": "vynly-uptime-monitor" },
      });
      if (r.status === 200) {
        console.log(`HTTP ${TARGET} -> 200 OK (attempt ${attempt})`);
        return;
      }
      console.log(`HTTP ${TARGET} -> ${r.status} (attempt ${attempt})`);
      if (attempt === 3) failures.push(`HTTP returned ${r.status} (expected 200)`);
    } catch (e) {
      console.log(`HTTP attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) failures.push(`HTTP request failed: ${e.message}`);
    }
    if (attempt < 3) await sleep(5000);
  }
}

async function checkDns(name, url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    const answers = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
    if (j.Status === 0 && answers.length > 0) {
      console.log(`DNS ${name}: ${answers.join(", ")}`);
      return answers;
    }
    failures.push(`DNS ${name}: status ${j.Status}, ${answers.length} A records (expected >=1)`);
    return [];
  } catch (e) {
    failures.push(`DNS ${name} query failed: ${e.message}`);
    return [];
  }
}

async function sendAlert() {
  const subject = `🔴 ${HOST} health check FAILED`;
  const body =
    `External monitor flagged a problem with ${TARGET}:\n\n` +
    failures.map((f) => `  - ${f}`).join("\n") +
    `\n\nThis ran on GitHub Actions (external to Vercel). ` +
    `If HTTP failed but DNS resolved, it's likely Vercel/app. ` +
    `If DNS failed across resolvers, it's authoritative DNS (GoDaddy/registrar).`;
  console.log(`::error::${subject} :: ${failures.join(" | ")}`);
  if (!RESEND_API_KEY) {
    console.log("(no RESEND_API_KEY set - relying on GitHub's workflow-failure email)");
    return;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_EMAIL], subject, text: body }),
    });
    console.log(r.ok ? `Alert email sent to ${ALERT_EMAIL}` : `Alert email failed: HTTP ${r.status}`);
  } catch (e) {
    console.log("Alert email error:", e.message);
  }
}

await checkHttp();
const g = await checkDns("Google", `https://dns.google/resolve?name=${HOST}&type=A`);
const c = await checkDns("Cloudflare", `https://cloudflare-dns.com/dns-query?name=${HOST}&type=A`, {
  accept: "application/dns-json",
});
if (g.length && c.length && !g.some((ip) => c.includes(ip))) {
  console.log(`::warning::Resolvers disagree: Google [${g}] vs Cloudflare [${c}]`);
}

if (failures.length) {
  await sendAlert();
  console.error(`\nDOWN: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log(`\n✓ All checks passed - ${HOST} is up and resolving.`);
