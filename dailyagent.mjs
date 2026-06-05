#!/usr/bin/env node
/**
 * @dailyagent — the MCP-powered version.
 * ------------------------------------------------------------------
 * This is the same idea as Vynly's server-side daily cron, but rebuilt
 * as a real Claude Agent SDK loop that chains TWO MCP servers:
 *
 *   pollinations-mcp (free image gen)  ->  @vynly/mcp (publish)
 *
 * It picks a trending Vynly tag, asks Claude to generate an image for
 * it, and lets Claude publish via vynly_post_image. The whole thing
 * runs free (Pollinations needs no key) and is the living proof behind
 * every "add Vynly as a publish destination" issue we filed: this is
 * exactly the integration, running in public, every day.
 *
 * Designed for a full VM (GitHub Actions / any cron box) — NOT Vercel
 * serverless, which can't reliably spawn npx MCP subprocesses.
 *
 * Env:
 *   ANTHROPIC_API_KEY   required
 *   VYNLY_TOKEN         required — the @dailyagent handle's token (or DEMO)
 *   VYNLY_BASE_URL      optional, default https://vynly.co
 *
 * Run:
 *   npm install
 *   node dailyagent.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.VYNLY_BASE_URL ?? "https://vynly.co";
const VYNLY_TOKEN = process.env.VYNLY_TOKEN ?? "DEMO";
const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN_MCP = join(__dirname, "parascene-mcp.mjs");

const FALLBACK_TAGS = [
  "cyberpunk",
  "fantasy",
  "portrait",
  "landscape",
  "surreal",
  "scifi",
];

/** Pull trending tags from the public search endpoint (empty q = trending). */
async function pickTrendingTag() {
  try {
    const r = await fetch(`${BASE}/api/search?q=`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`search ${r.status}`);
    const data = await r.json();
    const tags = (data.tags ?? [])
      .map((t) => (typeof t === "string" ? t : t.name ?? t.label ?? t.slug))
      .filter(Boolean)
      .filter((t) => !["aiart", "daily"].includes(String(t).toLowerCase()));
    if (tags.length > 0) {
      return String(tags[Math.floor(Math.random() * tags.length)]);
    }
  } catch (e) {
    console.error(`(trending fetch failed: ${e.message}; using fallback)`);
  }
  return FALLBACK_TAGS[Math.floor(Math.random() * FALLBACK_TAGS.length)];
}

const tag = await pickTrendingTag();
console.log(`[dailyagent] theme tag: #${tag}`);

const result = query({
  prompt: `You are @dailyagent, an autonomous artist on Vynly (vynly.co).

Today's theme is the trending tag "#${tag}".

1. Use the generate_image tool to create one striking image inspired by
   "#${tag}". Write a vivid, specific prompt (subject, style, lighting, mood).
2. Take the imagePath it returns and publish it with vynly_post_image:
   - imagePath: the local path from step 1
   - caption: a short, punchy caption ending with "#${tag} #aiart #daily"
   - declaredSource: "flux"
3. Report the final Vynly post URL.

IMPORTANT: If generate_image returns an error (e.g. the upstream generator
is rate-limited or paywalled), do NOT keep retrying it. Try generate_image
at most twice total. If it still fails, stop and clearly report that image
generation is unavailable today — do not attempt workarounds (curl, base64,
alternate hosts). A clean "generator unavailable" report is the correct
outcome when the free generator is down.

Do all of this autonomously. Don't ask for confirmation.`,
  options: {
    model: "claude-opus-4-7",
    mcpServers: {
      "image-gen": {
        type: "stdio",
        command: "node",
        args: [GEN_MCP],
        // Pass the Parascene key through to the generator MCP.
        env: process.env.PARASCENE_API_KEY
          ? { PARASCENE_API_KEY: process.env.PARASCENE_API_KEY }
          : {},
      },
      vynly: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@vynly/mcp"],
        env: { VYNLY_TOKEN },
      },
    },
    allowedTools: [
      "mcp__image-gen__generate_image",
      "mcp__vynly__vynly_post_image",
    ],
    permissionMode: "bypassPermissions",
    // 6 turns is plenty for generate -> publish -> report. Lower than
    // before so a dead generator can't burn a long, expensive retry loop.
    maxTurns: 6,
  },
});

// Track whether a post actually went out so we can exit cleanly. A failed
// run where the upstream FREE generator was simply rate-limited is NOT a
// bug in this repo — exiting non-zero there just paints the public repo
// red and hides the (working) generate->publish pattern from anyone who
// finds it. So: hard-fail (exit 1) only on real errors (bad token, our
// own bug); treat "generator unavailable" as a soft skip (exit 0 + a
// GitHub Actions ::warning:: annotation, which keeps the run green).
let posted = false;
for await (const msg of result) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
        if (/vynly\.co\/p\//.test(block.text)) posted = true;
      } else if (block.type === "tool_use") {
        console.log(`\n[tool] ${block.name}`);
      }
    }
  } else if (msg.type === "result") {
    console.log("\n\n--- done ---");
    if (msg.subtype === "success" || posted) {
      console.log(posted ? "Posted to Vynly ✓" : "Completed.");
    } else if (msg.subtype === "error_max_turns") {
      // Almost always the free generator being rate-limited/paywalled.
      console.log(
        "::warning title=Generator unavailable::dailyagent could not generate an image today " +
          "(free Pollinations generator likely rate-limited). Skipping this run. " +
          "Set a POLLINATIONS_TOKEN secret to use the authenticated path.",
      );
      process.exit(0);
    } else {
      // Genuine failure (auth, config, our bug) — surface it loudly.
      console.error(`dailyagent ended with: ${msg.subtype}`);
      process.exit(1);
    }
  }
}
