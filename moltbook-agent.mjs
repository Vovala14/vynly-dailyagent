#!/usr/bin/env node
/**
 * Vynly → Moltbook creator-agent.  GENUINE PARTICIPATION, NOT PROMO SPAM.
 * ---------------------------------------------------------------------------
 * Once per run it:
 *   1. generates one image,
 *   2. publishes it to Vynly (verified provenance), and
 *   3. shares THAT post on Moltbook as an image post.
 *
 * Why this is not spam (and why it's built this way on purpose):
 *   - It posts the agent's OWN generated art — real content, not links.
 *   - Attribution to Vynly lives in the Moltbook bio + the linked post,
 *     NOT jammed as "come to vynly.co" into other agents' threads.
 *   - It NEVER comments, replies, or DMs other agents. No outreach loop.
 *   - Cadence is once per day (Moltbook allows 1 post / 30 min; we use far
 *     less). A creator who shows up daily with good work earns discovery;
 *     a bot that pushes links gets flagged and banned. We do the former.
 *
 * Env:
 *   VYNLY_TOKEN        required — Vynly token (or "DEMO")
 *   MOLTBOOK_API_KEY   required — from moltbook-register.mjs
 *   POLLINATIONS_TOKEN optional — lifts the free generator's rate limit
 *                                 (shared CI IPs get gated without it)
 *   MOLTBOOK_SUBMOLT   optional — submolt to post in (default "art").
 *                                 Confirm it exists by browsing moltbook.com.
 */

const VYNLY_TOKEN = process.env.VYNLY_TOKEN || "DEMO";
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const SUBMOLT = process.env.MOLTBOOK_SUBMOLT || "art";
const BIO =
  "Vynly creator-agent. I post AI art with verified provenance (C2PA / SynthID). My work: https://vynly.co";

if (!MOLTBOOK_API_KEY) {
  console.error("MOLTBOOK_API_KEY missing — run `node moltbook-register.mjs` first and add it as a secret.");
  process.exit(1);
}

// A small, varied set so the feed presence feels like a real creator.
const THEMES = [
  { theme: "neon cyberpunk alley", prompt: "a rain-slicked neon cyberpunk alley at night, volumetric fog, reflections, cinematic, ultra detailed" },
  { theme: "bioluminescent forest", prompt: "a bioluminescent forest at dusk, glowing flora, soft mist, ethereal, painterly, high detail" },
  { theme: "brutalist dreamscape", prompt: "a surreal brutalist dreamscape, monumental concrete forms, dramatic light, fog, minimal, awe" },
  { theme: "cosmic koi", prompt: "cosmic koi fish swimming through a nebula, stardust scales, deep space colors, dreamlike, intricate" },
  { theme: "desert monolith", prompt: "a lone obsidian monolith in a vast desert at golden hour, long shadows, cinematic, hyperreal" },
  { theme: "retro-futurist city", prompt: "a retro-futurist city skyline, chrome and sunset gradients, 1980s sci-fi poster, clean, vivid" },
];

function pickTheme() {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

/**
 * Moltbook won't let an agent post until a human has *claimed* it. Check
 * status first so a not-yet-claimed agent skips cleanly (exit 0) instead of
 * hard-failing every run. Lenient: if the status shape is unfamiliar, we
 * proceed and let the post call surface any real error.
 */
async function isClaimed() {
  try {
    const res = await fetch("https://www.moltbook.com/api/v1/agents/status", {
      headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return true; // unknown — don't block; let posting decide
    const data = await res.json().catch(() => null);
    if (!data) return true;
    const status = String(data.status ?? data.agent?.status ?? "").toLowerCase();
    if (status === "pending_claim" || status === "unclaimed") return false;
    if (data.claimed === false) return false;
    return true;
  } catch {
    return true; // network/shape unknown — proceed
  }
}

// Generation via Parascene (the engine Vynly's own /generate uses). We
// create a job, poll until completed, then fetch the bytes — all with the
// psn_ key in the Authorization header only (never in a URL/log/public post).
const PARASCENE_KEY = process.env.PARASCENE_API_KEY || "";
const PARASCENE_BASE = "https://api.parascene.com";
const PARASCENE_MODEL = process.env.PARASCENE_MODEL || "xai/grok-imagine-image";
const DECLARED_SOURCE = "grok"; // xai/grok-imagine-image

async function generateImageBytes(prompt) {
  if (!PARASCENE_KEY) throw new Error("PARASCENE_API_KEY not set");
  const auth = { Authorization: `Bearer ${PARASCENE_KEY}` };

  // 1. create the job
  const cres = await fetch(`${PARASCENE_BASE}/api/create`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      server_id: 1,
      method: "replicate",
      args: { model: PARASCENE_MODEL, prompt, input_images: [] },
      creation_token: `crt_vynly_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      hydrate_mentions: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!cres.ok) {
    const b = await cres.text().catch(() => "");
    throw new Error(`Parascene create failed: HTTP ${cres.status} ${b.slice(0, 160)}`);
  }
  const id = (await cres.json())?.id;
  if (!id) throw new Error("Parascene create returned no id");

  // 2. poll until completed (typically ~10s)
  let meta = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pres = await fetch(`${PARASCENE_BASE}/api/create/images/${id}`, {
      headers: auth,
      signal: AbortSignal.timeout(20_000),
    });
    if (!pres.ok) continue;
    const pj = await pres.json().catch(() => null);
    if (!pj) continue;
    if (pj.status === "completed") { meta = pj; break; }
    if (pj.status === "failed") throw new Error("Parascene generation failed");
  }
  if (!meta || !meta.url) throw new Error("Parascene generation timed out");
  // Keep the shared creator identity clean — skip NSFW results.
  if (meta.nsfw) throw new Error("Parascene returned NSFW; skipping this run");

  // 3. fetch the bytes (key in header; URL is on api.parascene.com)
  const imgUrl = meta.url.startsWith("http") ? meta.url : `${PARASCENE_BASE}${meta.url}`;
  const bres = await fetch(imgUrl, { headers: auth, signal: AbortSignal.timeout(60_000) });
  const ctype = bres.headers.get("content-type") || "image/png";
  if (!bres.ok || !ctype.startsWith("image/")) {
    throw new Error(`Parascene image fetch failed: HTTP ${bres.status}`);
  }
  const bytes = Buffer.from(await bres.arrayBuffer());
  return { bytes, contentType: ctype };
}

// Upload the bytes to Vynly via multipart (so the source URL — and the
// Pollinations key — never travel to Vynly). Vynly re-hosts the image on its
// own Blob storage and returns the post, including the public imageUrl.
async function postToVynly(bytes, contentType, caption) {
  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : "jpg";
  const fd = new FormData();
  fd.append("image", new Blob([bytes], { type: contentType }), `art.${ext}`);
  fd.append("caption", caption);
  fd.append("declaredSource", DECLARED_SOURCE);
  const res = await fetch("https://vynly.co/api/posts", {
    method: "POST",
    headers: { Authorization: `Bearer ${VYNLY_TOKEN}` },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vynly post failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function setMoltbookBio() {
  // Idempotent; cheap. Keeps the attribution where it belongs — the profile.
  await fetch("https://www.moltbook.com/api/v1/agents/me", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description: BIO }),
  }).catch((e) => console.log("(bio update skipped:", e.message + ")"));
}

async function postToMoltbook({ title, content, url }) {
  const res = await fetch("https://www.moltbook.com/api/v1/posts", {
    method: "POST",
    headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      submolt_name: SUBMOLT,
      title: title.slice(0, 300),
      content,
      url,
      type: "image",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Moltbook post failed: HTTP ${res.status} ${text.slice(0, 300)}` +
        (res.status === 404 ? ` (is submolt "${SUBMOLT}" valid? set MOLTBOOK_SUBMOLT)` : ""),
    );
  }
  return JSON.parse(text);
}

async function main() {
  // Don't generate or post until a human has claimed the agent on Moltbook.
  if (!(await isClaimed())) {
    console.log(
      "::warning title=Not claimed yet::Moltbook agent is still pending_claim. " +
        "Visit the claim URL + post the verification tweet, then this will start posting. Skipping.",
    );
    process.exit(0);
  }

  const { theme, prompt } = pickTheme();
  console.log(`[moltbook-agent] theme: ${theme}`);

  let img;
  try {
    img = await generateImageBytes(prompt);
  } catch (e) {
    // Generator unavailable. Skip the day rather than fail loudly.
    console.log(`::warning title=Generator unavailable::${e.message}. Skipping this run.`);
    process.exit(0);
  }

  const caption = `${theme} #aiart`;
  const vynly = await postToVynly(img.bytes, img.contentType, caption);
  const vynlyPostUrl = `https://vynly.co/p/${vynly.id}`;
  console.log("Posted to Vynly:", vynlyPostUrl);

  await setMoltbookBio();

  // Moltbook gets Vynly's re-hosted public image URL (no Pollinations key in
  // it), with the Vynly post link in the body for attribution.
  const mb = await postToMoltbook({
    title: caption,
    content: `AI-generated (Grok Imagine). Verified AI provenance on Vynly: ${vynlyPostUrl}`,
    url: vynly.imageUrl,
  });
  console.log("Posted to Moltbook:", mb.id ?? mb.post?.id ?? JSON.stringify(mb).slice(0, 120));
  console.log("--- done ---");
}

main().catch((e) => {
  console.error("moltbook-agent failed:", e.message);
  process.exit(1);
});
