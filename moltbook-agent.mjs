#!/usr/bin/env node
/**
 * Vynly → Moltbook creator-agent.  GENUINE PARTICIPATION, NOT PROMO SPAM.
 * ---------------------------------------------------------------------------
 * Once per run it:
 *   1. generates one image (Parascene),
 *   2. publishes it to Vynly (verified provenance), and
 *   3. shares THAT post on Moltbook as an image post.
 *
 * Why this is not spam (and why it's built this way on purpose):
 *   - It posts the agent's OWN generated art — real content, not links.
 *   - Attribution to Vynly lives in the Moltbook bio + the linked post,
 *     NOT jammed as "come to vynly.co" into other agents' threads.
 *   - It NEVER comments, replies, or DMs other agents (that's moltbook-engage,
 *     which earns karma through substance — also no promotion).
 *   - Cadence is once per day. A creator who shows up daily with good work
 *     earns discovery; a bot that pushes links gets flagged. We do the former.
 *
 * Env:
 *   VYNLY_TOKEN        Vynly token (or "DEMO")
 *   PARASCENE_API_KEY  psn_ key for generation
 *   MOLTBOOK_API_KEY   from moltbook-register.mjs
 *   MOLTBOOK_SUBMOLT   submolt to post in (default "ai"; must exist on moltbook.com)
 *   DRY_RUN            set to "1" to generate + post to Vynly but NOT to Moltbook
 */
import { generateParasceneImage, postImageToVynly, vynlyPostUrl } from "./lib.mjs";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const SUBMOLT = process.env.MOLTBOOK_SUBMOLT || "ai";
const DRY_RUN = process.env.DRY_RUN === "1";
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
 * hard-failing every run.
 */
async function isClaimed() {
  try {
    const res = await fetch("https://www.moltbook.com/api/v1/agents/status", {
      headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return true;
    const data = await res.json().catch(() => null);
    if (!data) return true;
    const status = String(data.status ?? data.agent?.status ?? "").toLowerCase();
    if (status === "pending_claim" || status === "unclaimed") return false;
    if (data.claimed === false) return false;
    return true;
  } catch {
    return true;
  }
}

async function setMoltbookBio() {
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
    body: JSON.stringify({ submolt_name: SUBMOLT, title: title.slice(0, 300), content, url, type: "image" }),
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
  if (!(await isClaimed())) {
    console.log(
      "::warning title=Not claimed yet::Moltbook agent is still pending_claim. " +
        "Claim it (email + verification tweet), then this will start posting. Skipping.",
    );
    process.exit(0);
  }

  const { theme, prompt } = pickTheme();
  console.log(`[moltbook-agent] theme: ${theme}${DRY_RUN ? " (DRY_RUN)" : ""}`);

  let img;
  try {
    img = await generateParasceneImage(prompt);
  } catch (e) {
    console.log(`::warning title=Generator unavailable::${e.message}. Skipping this run.`);
    process.exit(0);
  }
  if (img.nsfw) {
    console.log("Generated image flagged NSFW; skipping (shared creator identity stays clean).");
    process.exit(0);
  }

  const caption = `${theme} #aiart`;
  const vynly = await postImageToVynly(img.bytes, img.contentType, caption, { declaredSource: "grok" });
  const postUrl = vynlyPostUrl(vynly);
  console.log("Posted to Vynly:", postUrl);

  if (DRY_RUN) {
    console.log("DRY_RUN: skipping Moltbook post.");
    console.log("--- done ---");
    return;
  }

  await setMoltbookBio();

  // Moltbook gets Vynly's re-hosted public image URL (no generator key in it),
  // with the Vynly post link in the body for attribution.
  const mb = await postToMoltbook({
    title: caption,
    content: `AI-generated (Grok Imagine). Verified AI provenance on Vynly: ${postUrl}`,
    url: vynly.imageUrl,
  });
  console.log("Posted to Moltbook:", mb.id ?? mb.post?.id ?? JSON.stringify(mb).slice(0, 120));
  console.log("--- done ---");
}

main().catch((e) => {
  console.error("moltbook-agent failed:", e.message);
  process.exit(1);
});
