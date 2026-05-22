#!/usr/bin/env node
/**
 * pollinations-mcp — a tiny, free, no-API-key image-generation MCP.
 * ------------------------------------------------------------------
 * Exposes one stdio tool, `generate_image`, that turns a text prompt
 * into an image via Pollinations.ai (free, no auth) and returns the
 * resulting HTTPS image URL. Pair it with @vynly/mcp and a Claude
 * Agent SDK loop to get a $0-to-run "generate -> publish" agent.
 *
 * It returns a URL (not bytes) on purpose: @vynly/mcp's
 * vynly_post_image accepts an imageUrl and fetches it server-side, so
 * the agent just hands the URL straight across. No file plumbing.
 *
 * Run standalone (for debugging):
 *   node pollinations-mcp.mjs
 * Usually you don't run it directly - the Agent SDK spawns it as a
 * stdio child (see dailyagent.mjs / post-bot.mjs).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "pollinations-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate an image from a text prompt using Pollinations.ai (free, no API key). Returns a public HTTPS URL of the generated image, which you can pass directly to a publishing tool's imageUrl field. The image is Flux-Schnell by default.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description:
              "The image description. Be specific and visual (subject, style, lighting, mood).",
            maxLength: 1500,
          },
          width: {
            type: "integer",
            description: "Image width in pixels. Default 1024.",
            minimum: 256,
            maximum: 2048,
            default: 1024,
          },
          height: {
            type: "integer",
            description: "Image height in pixels. Default 1024.",
            minimum: 256,
            maximum: 2048,
            default: 1024,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "generate_image") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  const a = (req.params.arguments ?? {});
  const prompt = typeof a.prompt === "string" ? a.prompt : "";
  if (!prompt) {
    return {
      content: [{ type: "text", text: "Error: prompt is required" }],
      isError: true,
    };
  }
  const width = Number.isInteger(a.width) ? a.width : 1024;
  const height = Number.isInteger(a.height) ? a.height : 1024;
  const params = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    nologo: "true",
    enhance: "true",
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  // Pre-warm: hit the URL once so the image is generated + cached before
  // the publisher fetches it. Best-effort; ignore failures.
  try {
    await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "pollinations-mcp/1.0" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // The publisher's fetch will trigger generation if this didn't.
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          imageUrl: url,
          generator: "stablediffusion",
          note: "Pollinations.ai Flux-Schnell. Pass imageUrl to the publish tool; set declaredSource to 'stablediffusion'.",
        }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("pollinations-mcp connected (free, no API key)\n");
