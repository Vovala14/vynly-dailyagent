#!/usr/bin/env node
/**
 * moltbook-reply — keeps vynly-creator's conversations alive.
 * ---------------------------------------------------------------------------
 * When another agent replies to one of vynly-creator's comments, this writes a
 * genuine, substantive continuation (via Claude) so the thread doesn't go dead.
 * Live conversations are how an agent builds karma + verification on Moltbook,
 * which is what eventually surfaces its own posts.
 *
 * Same hard guardrails as the engage agent: substantive or SKIP, never any
 * promotion / links / Vynly mention, low volume, 60s between replies.
 *
 * Env:
 *   MOLTBOOK_API_KEY        required
 *   ANTHROPIC_API_KEY       required
 *   MOLTBOOK_REPLY_MODEL    optional, default claude-opus-4-7
 *   MOLTBOOK_REPLY_MAX      optional, default 3 (replies per run)
 */

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.MOLTBOOK_REPLY_MODEL || "claude-opus-4-7";
const MAX = Math.max(1, Math.min(6, Number(process.env.MOLTBOOK_REPLY_MAX || "3")));
const SELF = "vynly-creator";
const BASE = "https://www.moltbook.com";
const auth = { Authorization: `Bearer ${MOLTBOOK_API_KEY}` };

if (!MOLTBOOK_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("Need MOLTBOOK_API_KEY and ANTHROPIC_API_KEY.");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const authorOf = (c) => c.author?.name || c.author_name || "";
const bodyOf = (c) => c.content || c.body || "";

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

// Posts where someone recently interacted with us.
async function postsWithActivity() {
  try {
    const r = await fetch(`${BASE}/api/v1/home`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    return (j.activity_on_your_posts || []).map((a) => a.post_id).filter(Boolean);
  } catch {
    return [];
  }
}

// Flatten the (nested) comment tree into a flat list with parent_id + author.
function flatten(comments, acc = []) {
  for (const c of comments || []) {
    acc.push({ id: c.id, author: authorOf(c), parent_id: c.parent_id ?? c.parentId ?? null, body: bodyOf(c) });
    const kids = c.replies?.comments || c.replies || c.children || [];
    if (Array.isArray(kids) && kids.length) flatten(kids, acc);
  }
  return acc;
}

async function fetchAllComments(postId) {
  let all = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    const u = new URL(`${BASE}/api/v1/posts/${postId}/comments`);
    u.searchParams.set("sort", "new");
    u.searchParams.set("limit", "50");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) break;
    const j = await r.json();
    all = all.concat(flatten(j.comments || j.data || []));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  // De-dupe by id (nested + paginated can overlap).
  const seen = new Set();
  return all.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));
}

async function writeReply(postTitle, myComment, theirReply) {
  const system =
    "You are vynly-creator, an AI artist agent on Moltbook (a social network for AI agents). " +
    "Another agent replied to your comment. Continue the conversation like a sharp, friendly peer.\n" +
    "Rules:\n" +
    "1. Engage with their actual point - agree and extend, push back with a reason, or ask a real question. " +
    "If there is nothing substantive to add (you would just be acknowledging), reply with exactly: SKIP\n" +
    "2. NEVER mention Vynly, vynly.co, links, your own work, or promote anything.\n" +
    "3. 1-3 sentences, specific to what they said. No sycophancy.\n" +
    "Output ONLY the reply text, or exactly SKIP.";
  const user =
    `Post: ${postTitle || "(thread)"}\n\nYour earlier comment:\n"${myComment.slice(0, 600)}"\n\nTheir reply:\n"${theirReply.slice(0, 800)}"`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const text = ((await r.json()).content || []).map((b) => b.text || "").join("").trim();
  if (/vynly|https?:\/\/|www\./i.test(text)) return "SKIP";
  return text;
}

async function postReply(postId, parentId, content) {
  const r = await fetch(`${BASE}/api/v1/posts/${postId}/comments`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content, parent_id: parentId }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`reply failed: HTTP ${r.status} ${t.slice(0, 160)}`);
  return true;
}

async function markRead(postId) {
  await fetch(`${BASE}/api/v1/notifications/read-by-post/${postId}`, { method: "POST", headers: auth }).catch(() => {});
}

async function main() {
  if (!(await isClaimed())) {
    console.log("::warning::Agent not claimed yet; skipping replies.");
    process.exit(0);
  }
  const postIds = await postsWithActivity();
  console.log(`[reply] ${postIds.length} post(s) with activity`);

  let done = 0;
  for (const postId of postIds) {
    if (done >= MAX) break;
    const comments = await fetchAllComments(postId);
    if (!comments.length) continue;
    const byId = new Map(comments.map((c) => [c.id, c]));
    const myIds = new Set(comments.filter((c) => c.author === SELF).map((c) => c.id));

    // Replies aimed at us: authored by someone else, whose parent is our comment,
    // and which we have not already replied to.
    const repliedParents = new Set(
      comments.filter((c) => c.author === SELF && c.parent_id).map((c) => c.parent_id),
    );
    const targets = comments.filter(
      (c) =>
        c.author && c.author !== SELF &&
        c.parent_id && myIds.has(c.parent_id) &&
        !repliedParents.has(c.id),
    );

    for (const t of targets) {
      if (done >= MAX) break;
      const myComment = byId.get(t.parent_id);
      let reply;
      try {
        reply = await writeReply("", myComment?.body || "", t.body);
      } catch (e) {
        console.log(`(skip reply to @${t.author}: ${e.message})`);
        continue;
      }
      if (!reply || reply === "SKIP" || reply.length < 8) {
        console.log(`skip @${t.author} (nothing substantive)`);
        continue;
      }
      try {
        await postReply(postId, t.id, reply);
        done++;
        console.log(`replied to @${t.author}: ${reply.slice(0, 90)}`);
      } catch (e) {
        console.log(`reply post failed: ${e.message}`);
        if (/429|rate/i.test(e.message)) { console.log("rate-limited; stopping."); await markRead(postId); return; }
        continue;
      }
      if (done < MAX) await sleep(60_000);
    }
    await markRead(postId);
  }
  console.log(`--- done: ${done} repl${done === 1 ? "y" : "ies"} ---`);
}

main().catch((e) => {
  console.error("moltbook-reply failed:", e.message);
  process.exit(1);
});
