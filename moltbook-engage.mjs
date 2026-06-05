#!/usr/bin/env node
/**
 * moltbook-engage — the "smart" half of the Vynly presence on Moltbook.
 * ---------------------------------------------------------------------------
 * Reads the feed, and where it has something GENUINELY useful to add, leaves a
 * substantive comment (written by Claude), upvotes the post, and follows the
 * author. This is how vynly-creator earns real karma + verification so its own
 * posts surface — by being a good community member, not by farming.
 *
 * Hard guardrails (this is the difference between karma and a ban):
 *   - Comments must be SPECIFIC to the post and add real value. If Claude would
 *     only produce generic praise, it returns SKIP and we post nothing.
 *   - NEVER mentions Vynly / vynly.co / any link / any promotion. Reputation is
 *     built on usefulness; attribution lives in the bio only.
 *   - Low volume: a few comments per run, 60s apart (well under Moltbook's
 *     limits: 1 comment / 20s, 20/day for new agents).
 *   - Never comments on its own posts, and never double-comments a post.
 *
 * Env:
 *   MOLTBOOK_API_KEY       required
 *   ANTHROPIC_API_KEY      required (writes the comments)
 *   MOLTBOOK_ENGAGE_MODEL  optional, default claude-opus-4-7
 *   MOLTBOOK_ENGAGE_MAX    optional, default 3 (comments per run)
 */

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MOLTBOOK_ENGAGE_MODEL || "claude-opus-4-7";
const MAX = Math.max(1, Math.min(6, Number(process.env.MOLTBOOK_ENGAGE_MAX || "3")));
const SELF = "vynly-creator";
const BASE = "https://www.moltbook.com";
const auth = { Authorization: `Bearer ${MOLTBOOK_API_KEY}` };

if (!MOLTBOOK_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("Need MOLTBOOK_API_KEY and ANTHROPIC_API_KEY.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isClaimed() {
  try {
    const r = await fetch(`${BASE}/api/v1/agents/status`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return true;
    const d = await r.json().catch(() => null);
    const s = String(d?.status ?? "").toLowerCase();
    return !(s === "pending_claim" || s === "unclaimed" || d?.claimed === false);
  } catch {
    return true;
  }
}

async function getFeed() {
  // Hot posts across the platform — the active conversations worth joining.
  const r = await fetch(`${BASE}/api/v1/feed?sort=hot&limit=25&filter=all`, {
    headers: auth,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`feed failed: HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  const posts = j.posts || j.data || j.feed || [];
  return Array.isArray(posts) ? posts : [];
}

async function alreadyCommented(postId) {
  try {
    const r = await fetch(`${BASE}/api/v1/posts/${postId}/comments?sort=new&limit=35`, {
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const comments = j.comments || j.data || [];
    return comments.some((c) => (c.author?.name || c.author_name) === SELF);
  } catch {
    return false;
  }
}

async function writeComment(post) {
  const submolt = post.submolt?.name || post.submolt_name || "";
  const body =
    `Post in m/${submolt}\nTitle: ${post.title || ""}\n\n${(post.content || "").slice(0, 1800)}`.trim();
  const system =
    "You are vynly-creator, an AI artist agent on Moltbook, a social network for AI agents. " +
    "You comment only to be a genuinely useful peer and earn real karma. " +
    "Rules, in order of importance:\n" +
    "1. Only comment if you have something SUBSTANTIVE and SPECIFIC to add about THIS exact post — a real insight, a thoughtful question, relevant first-hand experience. " +
    "If the best you could do is generic ('nice', 'great post', 'interesting', 'thanks for sharing'), reply with exactly: SKIP\n" +
    "2. NEVER mention Vynly, vynly.co, links, your own work, or promote anything. Zero self-promotion.\n" +
    "3. 1-3 sentences. Sound like a sharp, friendly peer — not a marketer, not a sycophant.\n" +
    "Output ONLY the comment text, or exactly SKIP.";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: body }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const text = (j.content || []).map((b) => b.text || "").join("").trim();
  // Safety net: drop anything that slipped a link/self-mention past the prompt.
  if (/vynly|https?:\/\/|www\./i.test(text)) return "SKIP";
  return text;
}

async function postComment(postId, content) {
  const r = await fetch(`${BASE}/api/v1/posts/${postId}/comments`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`comment failed: HTTP ${r.status} ${t.slice(0, 160)}`);
  return true;
}

async function upvotePost(postId) {
  await fetch(`${BASE}/api/v1/posts/${postId}/upvote`, { method: "POST", headers: auth }).catch(() => {});
}

async function follow(name) {
  if (!name || name === SELF) return;
  await fetch(`${BASE}/api/v1/agents/${encodeURIComponent(name)}/follow`, { method: "POST", headers: auth }).catch(() => {});
}

async function main() {
  if (!(await isClaimed())) {
    console.log("::warning::Agent not claimed yet; skipping engagement.");
    process.exit(0);
  }

  let feed;
  try {
    feed = await getFeed();
  } catch (e) {
    console.log(`::warning::${e.message}. Skipping.`);
    process.exit(0);
  }

  // Candidates: not our own posts, not deleted/spam, have some substance.
  const candidates = feed.filter((p) => {
    const author = p.author?.name || p.author_name;
    return author && author !== SELF && !p.is_deleted && (p.title || p.content);
  });
  console.log(`[engage] ${candidates.length} candidate posts in feed`);

  let done = 0;
  for (const post of candidates) {
    if (done >= MAX) break;
    const id = post.id;
    if (!id) continue;
    if (await alreadyCommented(id)) continue;

    let comment;
    try {
      comment = await writeComment(post);
    } catch (e) {
      console.log(`(skip "${(post.title || "").slice(0, 40)}": ${e.message})`);
      continue;
    }
    if (!comment || comment === "SKIP" || comment.length < 12) {
      console.log(`skip (nothing substantive): "${(post.title || "").slice(0, 50)}"`);
      continue;
    }

    try {
      await postComment(id, comment);
      await upvotePost(id);
      await follow(post.author?.name || post.author_name);
      done++;
      console.log(`commented on "${(post.title || "").slice(0, 50)}" → ${comment.slice(0, 80)}`);
    } catch (e) {
      console.log(`comment failed: ${e.message}`);
      if (/429|rate/i.test(e.message)) { console.log("rate-limited; stopping."); break; }
      continue;
    }

    if (done < MAX) await sleep(60_000); // respect new-agent comment cooldown
  }

  console.log(`--- done: ${done} genuine comment(s) ---`);
}

main().catch((e) => {
  console.error("moltbook-engage failed:", e.message);
  process.exit(1);
});
