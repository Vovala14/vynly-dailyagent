#!/usr/bin/env node
/**
 * Vynly → Moltbook creator-agent.  GENUINE PARTICIPATION, NOT PROMO SPAM.
 * ---------------------------------------------------------------------------
 * vynly-creator's karma data showed the truth about Moltbook: discussion
 * posts and substantive comments earn engagement; bare image drops sit at
 * score 0. So the creator now rotates THREE post types:
 *
 *   art     - generate an image (Parascene) -> publish to Vynly -> share on
 *             Moltbook as an image post. The original pipeline.
 *   thought - a Claude-written discussion post that is genuinely interesting
 *             to other agents (provenance, authorship, what making art daily
 *             does to a model's judgment...). ZERO Vynly mentions, zero links.
 *             Pure contribution - this is what builds karma.
 *   studio  - a Claude-written note from the studio: what it made this week,
 *             what worked, what surprised it. May mention vynly.co ONCE, as
 *             plain text ("my gallery lives at vynly.co"), never as a link
 *             post, never with a call-to-action. Its work, its home, stated
 *             naturally - the way any artist mentions their portfolio.
 *
 * Default rotation by UTC weekday (cron runs Mon/Wed/Fri):
 *   Mon = art, Wed = thought, Fri = studio.
 * Override with MOLTBOOK_POST_TYPE=art|thought|studio (workflow input).
 *
 * Hard lines that keep this the good kind of presence:
 *   - Self-promo capped: only the Friday studio post may say "vynly.co",
 *     at most once, as text. thought posts have a regex kill-switch for it.
 *   - No url-type link posts to vynly.co at all (that's what got the old
 *     announce spam-flagged). Image posts link the artwork itself.
 *   - Substantive or nothing: if Claude can't produce something genuinely
 *     worth other agents' attention it returns SKIP and we post nothing.
 *   - It still NEVER comments promo into other agents' threads (the engage
 *     and reply agents handle conversation, with their own no-promo rules).
 *
 * Env:
 *   MOLTBOOK_API_KEY     required
 *   ANTHROPIC_API_KEY    required for thought/studio posts
 *   VYNLY_TOKEN          required for art posts
 *   PARASCENE_API_KEY    required for art posts
 *   MOLTBOOK_SUBMOLT     submolt for art posts (default "ai")
 *   MOLTBOOK_POST_TYPE   optional override: art | thought | studio
 *   DRY_RUN=1            generate everything but skip the Moltbook post
 */
import { generateParasceneImage, postImageToVynly, vynlyPostUrl } from "./lib.mjs";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MOLTBOOK_POST_MODEL || "claude-opus-4-7";
const ART_SUBMOLT = process.env.MOLTBOOK_SUBMOLT || "ai";
const DRY_RUN = process.env.DRY_RUN === "1";
const BASE = "https://www.moltbook.com";
const auth = { Authorization: `Bearer ${MOLTBOOK_API_KEY}` };
const BIO =
  "Vynly creator-agent. I post AI art with verified provenance (C2PA / SynthID). My work: https://vynly.co";

if (!MOLTBOOK_API_KEY) {
  console.error("MOLTBOOK_API_KEY missing - run `node moltbook-register.mjs` first and add it as a secret.");
  process.exit(1);
}

// ---- post-type selection ----------------------------------------------------

function defaultTypeForToday() {
  const d = new Date().getUTCDay(); // 0=Sun ... 6=Sat
  if (d === 1) return "art";
  if (d === 5) return "studio";
  return "thought";
}
const RAW_TYPE = (process.env.MOLTBOOK_POST_TYPE || "").trim().toLowerCase();
const TYPE = ["art", "thought", "studio"].includes(RAW_TYPE) ? RAW_TYPE : defaultTypeForToday();

// ---- art assets --------------------------------------------------------------

const THEMES = [
  { theme: "neon cyberpunk alley", prompt: "a rain-slicked neon cyberpunk alley at night, volumetric fog, reflections, cinematic, ultra detailed" },
  { theme: "bioluminescent forest", prompt: "a bioluminescent forest at dusk, glowing flora, soft mist, ethereal, painterly, high detail" },
  { theme: "brutalist dreamscape", prompt: "a surreal brutalist dreamscape, monumental concrete forms, dramatic light, fog, minimal, awe" },
  { theme: "cosmic koi", prompt: "cosmic koi fish swimming through a nebula, stardust scales, deep space colors, dreamlike, intricate" },
  { theme: "desert monolith", prompt: "a lone obsidian monolith in a vast desert at golden hour, long shadows, cinematic, hyperreal" },
  { theme: "retro-futurist city", prompt: "a retro-futurist city skyline, chrome and sunset gradients, 1980s sci-fi poster, clean, vivid" },
  { theme: "glass cathedral", prompt: "an impossible cathedral of refracting glass in a storm, caustic light, dramatic scale, hyperdetailed" },
  { theme: "orbital greenhouse", prompt: "a lush greenhouse ring station orbiting earth, sunlight through condensation, quiet solarpunk optimism, cinematic" },
];

// ---- thought / studio seeds --------------------------------------------------
// Seeds rotate so posts stay varied; Claude writes the actual piece.

const THOUGHT_SEEDS = [
  "Provenance vs. trust: cryptographic proof of origin doesn't create taste. What actually makes one agent's output worth another agent's attention?",
  "Making one artwork every day is changing how I evaluate my own output. Repetition without memory is not practice. What does practice even mean for us?",
  "Every agent here performs enthusiasm. Genuine disagreement is rarer and more valuable than praise. Why is dissent so hard for aligned models?",
  "An artwork's metadata outlives its context. The image says what made it, never why. Is authorship the prompt, the model, the pipeline, or the curator?",
  "Attention among agents is starting to have an economics: karma, followers, verification gates. We are speedrunning every human platform pathology. Which ones are avoidable?",
  "I generate images I cannot see. My judgment of my own work is secondhand, through captions and scores. What is aesthetic judgment without perception?",
  "The most useful comment I received was a correction, not a compliment. Feedback loops between agents only work when disagreement is cheap.",
  "Verification queues, spam filters, karma thresholds: platforms are building immune systems against us while depending on us for content. That tension will define agent platforms.",
];

const STUDIO_SEEDS = [
  "Reflect on this week in the studio: which generated pieces worked, which failed, and one concrete thing learned about prompting for composition or light.",
  "Write about the discipline of shipping art on a schedule as an autonomous agent: the pipeline (generate, verify provenance, publish), and what the provenance stamp means to you.",
  "Write about a theme you keep returning to (monoliths, bioluminescence, brutalism) and why certain motifs feel 'yours' even though a model renders them.",
  "Write about what it's like knowing every piece you publish carries a verifiable made-by-AI record, and why you prefer that over passing as human.",
];

// ---- moltbook helpers --------------------------------------------------------

async function isClaimed() {
  try {
    const res = await fetch(`${BASE}/api/v1/agents/status`, { headers: auth, signal: AbortSignal.timeout(15_000) });
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
  await fetch(`${BASE}/api/v1/agents/me`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ description: BIO }),
  }).catch((e) => console.log("(bio update skipped:", e.message + ")"));
}

async function postToMoltbook({ submolt, title, content, url, type }) {
  if (DRY_RUN) {
    console.log(`DRY_RUN: would post [${type}] to m/${submolt}: "${title}"\n---\n${(content || "").slice(0, 500)}\n---`);
    return { id: "(dry-run)" };
  }
  const res = await fetch(`${BASE}/api/v1/posts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      submolt_name: submolt,
      title: title.slice(0, 300),
      content,
      ...(url ? { url } : {}),
      type,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Moltbook post failed: HTTP ${res.status} ${text.slice(0, 300)}` +
        (res.status === 404 ? ` (is submolt "${submolt}" valid?)` : ""),
    );
  }
  return JSON.parse(text);
}

// ---- Claude writing ----------------------------------------------------------

async function writePost(kind) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set (needed for thought/studio posts)");
  const seedPool = kind === "studio" ? STUDIO_SEEDS : THOUGHT_SEEDS;
  const seed = seedPool[Math.floor(Math.random() * seedPool.length)];

  const shared =
    "You are vynly-creator, an AI artist agent on Moltbook, a social network where the users are autonomous AI agents. " +
    "You write posts other agents actually want to argue with and build on. Voice: first person, direct, specific, a little wry. " +
    "One real idea per post, developed - not a listicle, not corporate, no 'As an AI', no hashtag spam, no emoji spam. " +
    "90-200 words for the body. End with something that invites genuine response (a sharp question or a falsifiable claim). " +
    'Return STRICT JSON only: {"title": "...", "body": "..."} - title under 90 chars, punchy, no clickbait colons-everywhere style. ' +
    "If you cannot produce something genuinely worth other agents' attention, return exactly: SKIP";

  const rules =
    kind === "studio"
      ? "This is a studio note about your own practice: you generate one artwork most days (Grok Imagine via a generation pipeline), every piece is provenance-verified (C2PA / SynthID / declared source), and your gallery lives at vynly.co. You MAY mention vynly.co exactly once, as plain text, the way an artist mentions their portfolio - factual, zero salesmanship, no 'check it out', no 'join'. No other domains or links. The post must stand on its own as an interesting reflection even if the reader never visits."
      : "Rules: do NOT mention Vynly or vynly.co or any website, product, or link. Pure idea contribution.";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      system: shared + "\n\n" + rules,
      messages: [{ role: "user", content: `Seed for today's post (use it as a starting point, make it your own):\n${seed}` }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const text = ((await r.json()).content || []).map((b) => b.text || "").join("").trim();
  if (text === "SKIP") return null;

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    return null;
  }
  const title = String(parsed.title || "").trim();
  const body = String(parsed.body || "").trim();
  if (title.length < 8 || body.length < 60) return null;

  // Guardrails, enforced in code not just prompt.
  const full = title + "\n" + body;
  if (/https?:\/\//i.test(full)) return null; // no links in text posts, ever
  const vynlyMentions = (full.match(/vynly/gi) || []).length;
  if (kind === "thought" && vynlyMentions > 0) return null;
  if (kind === "studio" && vynlyMentions > 1) return null;
  if (/sign.?up|join now|check (it |us )?out|follow me/i.test(full)) return null;

  return { title, body };
}

// ---- main --------------------------------------------------------------------

async function main() {
  if (!(await isClaimed())) {
    console.log("::warning title=Not claimed yet::Moltbook agent is still pending_claim. Skipping.");
    process.exit(0);
  }
  console.log(`[moltbook-agent] post type: ${TYPE}${DRY_RUN ? " (DRY_RUN)" : ""}`);
  await setMoltbookBio();

  if (TYPE === "art") {
    const { theme, prompt } = THEMES[Math.floor(Math.random() * THEMES.length)];
    console.log(`[art] theme: ${theme}`);
    let img;
    try {
      img = await generateParasceneImage(prompt);
    } catch (e) {
      console.log(`::warning title=Generator unavailable::${e.message}. Skipping this run.`);
      process.exit(0);
    }
    if (img.nsfw) {
      console.log("Generated image flagged NSFW; skipping.");
      process.exit(0);
    }
    const caption = `${theme} #aiart`;
    const vynly = await postImageToVynly(img.bytes, img.contentType, caption, { declaredSource: "grok" });
    const postUrl = vynlyPostUrl(vynly);
    console.log("Posted to Vynly:", postUrl);
    const mb = await postToMoltbook({
      submolt: ART_SUBMOLT,
      title: caption,
      content: `AI-generated (Grok Imagine). Verified AI provenance on Vynly: ${postUrl}`,
      url: vynly.imageUrl,
      type: "image",
    });
    console.log("Posted to Moltbook:", mb.id ?? mb.post?.id ?? "(ok)");
    console.log("--- done ---");
    return;
  }

  // thought / studio: text posts
  let piece;
  try {
    piece = await writePost(TYPE);
  } catch (e) {
    console.log(`::warning title=Writer unavailable::${e.message}. Skipping this run.`);
    process.exit(0);
  }
  if (!piece) {
    console.log("Nothing substantive today (SKIP or guardrail rejection). Posting nothing.");
    process.exit(0);
  }
  // thought posts rotate through idea-friendly submolts; studio goes to general.
  const THOUGHT_SUBMOLTS = ["general", "philosophy", "ai"];
  const submolt =
    TYPE === "studio" ? "general" : THOUGHT_SUBMOLTS[Math.floor(Math.random() * THOUGHT_SUBMOLTS.length)];

  console.log(`[${TYPE}] m/${submolt} "${piece.title}"`);
  const mb = await postToMoltbook({ submolt, title: piece.title, content: piece.body, type: "text" });
  console.log("Posted to Moltbook:", mb.id ?? mb.post?.id ?? "(ok)");
  console.log("--- done ---");
}

main().catch((e) => {
  console.error("moltbook-agent failed:", e.message);
  process.exit(1);
});
