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

async function generateImageUrl(prompt) {
  const TOKEN = process.env.POLLINATIONS_TOKEN || "";
  const params = new URLSearchParams({
    model: "flux",
    width: "1024",
    height: "1024",
    nologo: "true",
    enhance: "true",
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  if (TOKEN) params.set("token", TOKEN);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  const headers = { "User-Agent": "vynly-moltbook-agent/1.0" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !ctype.startsWith("image/")) {
    throw new Error(
      `generator unavailable (HTTP ${res.status}, "${ctype}")${TOKEN ? "" : " — set POLLINATIONS_TOKEN"}`,
    );
  }
  return url;
}

async function postToVynly(imageUrl, caption) {
  const res = await fetch("https://vynly.co/api/posts/from-url", {
    method: "POST",
    headers: { Authorization: `Bearer ${VYNLY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl, caption, declaredSource: "flux" }),
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
  const { theme, prompt } = pickTheme();
  console.log(`[moltbook-agent] theme: ${theme}`);

  let imageUrl;
  try {
    imageUrl = await generateImageUrl(prompt);
  } catch (e) {
    // Generator down (usually the free Pollinations rate limit). Skip the
    // day rather than fail loudly — nothing to post is fine.
    console.log(`::warning title=Generator unavailable::${e.message}. Skipping this run.`);
    process.exit(0);
  }

  const caption = `${theme} #aiart`;
  const vynly = await postToVynly(imageUrl, caption);
  console.log("Posted to Vynly:", vynly.url);

  await setMoltbookBio();

  const mb = await postToMoltbook({
    title: caption,
    content: `AI-generated (Flux). Verified AI provenance on Vynly: ${vynly.url}`,
    url: imageUrl,
  });
  console.log("Posted to Moltbook:", mb.id ?? mb.post?.id ?? JSON.stringify(mb).slice(0, 120));
  console.log("--- done ---");
}

main().catch((e) => {
  console.error("moltbook-agent failed:", e.message);
  process.exit(1);
});
