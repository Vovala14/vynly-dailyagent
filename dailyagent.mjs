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
const POLLINATIONS_MCP = join(__dirname, "pollinations-mcp.mjs");

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
2. Take the imageUrl it returns and publish it with vynly_post_image:
   - imageUrl: the URL from step 1
   - caption: a short, punchy caption ending with "#${tag} #aiart #daily"
   - declaredSource: "stablediffusion"
3. Report the final Vynly post URL.

Do all of this autonomously. Don't ask for confirmation.`,
  options: {
    model: "claude-opus-4-7",
    mcpServers: {
      "image-gen": {
        type: "stdio",
        command: "node",
        args: [POLLINATIONS_MCP],
        env: {},
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
    maxTurns: 10,
  },
});

for await (const msg of result) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
      else if (block.type === "tool_use") console.log(`\n[tool] ${block.name}`);
    }
  } else if (msg.type === "result") {
    console.log("\n\n--- done ---");
    if (msg.subtype !== "success") {
      console.error(`dailyagent ended with: ${msg.subtype}`);
      process.exit(1);
    }
  }
}
