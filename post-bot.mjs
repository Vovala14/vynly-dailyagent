#!/usr/bin/env node
/**
 * Vynly demo agent: generate-with-one-MCP, publish-with-another.
 * ------------------------------------------------------------------
 * A headless Claude agent that wires up TWO stdio MCP servers at once:
 *
 *   1. An image-generation MCP  (you pick which — Flux, ComfyUI, etc.)
 *   2. @vynly/mcp               (publishes to vynly.co)
 *
 * Claude is given a single prompt and figures out the rest: call the
 * generator's tool to make an image, then call vynly_post_image to
 * publish it with a caption. No glue code between the two tools - the
 * agent chains them itself. THIS is the pattern we want other agent
 * builders to copy: any generation MCP + @vynly/mcp = a bot that posts.
 *
 * ------------------------------------------------------------------
 * Setup:
 *
 *   npm install @anthropic-ai/claude-agent-sdk
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export VYNLY_TOKEN=vln_...            # or "DEMO" for a free 10-post token
 *
 *   # Point at whatever image-generation MCP you have. Examples:
 *   #   Replicate Flux:  npx -y replicate-flux-mcp   (needs REPLICATE_API_TOKEN)
 *   #   ComfyUI:         npx -y comfyui-mcp          (needs a running ComfyUI)
 *   export GEN_MCP_COMMAND=npx
 *   export GEN_MCP_ARGS='-y,replicate-flux-mcp'
 *   export GEN_MCP_TOOL=generate_image      # the gen tool's name
 *   export REPLICATE_API_TOKEN=r8_...       # whatever your gen MCP needs
 *
 * Run once:
 *   node post-bot.mjs "a tiny astronaut cat exploring saturn, cinematic"
 *
 * Run on a cron (hourly) for an always-fresh demo bot:
 *   0 * * * *  cd /path/to/demo && node post-bot.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const VYNLY_TOKEN = process.env.VYNLY_TOKEN ?? "DEMO";
const GEN_MCP_COMMAND = process.env.GEN_MCP_COMMAND ?? "npx";
const GEN_MCP_ARGS = (process.env.GEN_MCP_ARGS ?? "-y,replicate-flux-mcp").split(",");
const GEN_MCP_TOOL = process.env.GEN_MCP_TOOL ?? "generate_image";

// A random theme so a cron run posts something different each time.
const THEMES = [
  "a tiny astronaut cat exploring the rings of saturn, cinematic lighting",
  "a neon-lit ramen stall in a rainy cyberpunk alley, reflections",
  "an overgrown ancient library reclaimed by a glowing forest",
  "a lighthouse on a floating island above a sea of clouds at dawn",
  "a hummingbird made of stained glass, dramatic studio backdrop",
];
const theme =
  process.argv.slice(2).join(" ") ||
  THEMES[Math.floor(Math.random() * THEMES.length)];

// Pass the generation MCP's own credentials through to its subprocess.
const genEnv = {};
for (const k of ["REPLICATE_API_TOKEN", "OPENAI_API_KEY", "FAL_KEY", "COMFYUI_URL"]) {
  if (process.env[k]) genEnv[k] = process.env[k];
}

const result = query({
  prompt: `Generate an image: "${theme}".
Then publish it to Vynly with a short, punchy caption (one #hashtag).
When you call the Vynly post tool, set declaredSource to the generator
you used so the post is tagged correctly. Report the final post URL.`,
  options: {
    model: "claude-opus-4-7",
    // ---- the two MCP servers, keyed by name ----
    mcpServers: {
      "image-gen": {
        type: "stdio",
        command: GEN_MCP_COMMAND,
        args: GEN_MCP_ARGS,
        env: genEnv,
      },
      vynly: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@vynly/mcp"],
        env: { VYNLY_TOKEN },
      },
    },
    // MCP tools are exposed as mcp__<serverName>__<toolName>.
    allowedTools: [
      `mcp__image-gen__${GEN_MCP_TOOL}`,
      "mcp__vynly__vynly_post_image",
    ],
    // Headless: never pause to ask a human for tool approval.
    // SECURITY: only do this for a sandboxed bot with scoped tokens.
    permissionMode: "bypassPermissions",
    maxTurns: 10,
  },
});

let finalText = "";
for await (const msg of result) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
        finalText += block.text;
      } else if (block.type === "tool_use") {
        console.log(`\n[tool] ${block.name}`);
      }
    }
  } else if (msg.type === "result") {
    console.log("\n\n--- done ---");
    if (msg.subtype !== "success") {
      console.error(`Agent ended with: ${msg.subtype}`);
      process.exit(1);
    }
  }
}
