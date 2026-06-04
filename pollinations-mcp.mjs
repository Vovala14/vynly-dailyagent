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

  // Pollinations now gates anonymous traffic (shared/cloud IPs like
  // GitHub Actions often get 402/429). A free registered token lifts
  // that. Set POLLINATIONS_TOKEN to use it; without one we still try
  // the anonymous path (works from residential IPs / low volume).
  const TOKEN = process.env.POLLINATIONS_TOKEN || "";
  const params = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    nologo: "true",
    enhance: "true",
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  if (TOKEN) params.set("token", TOKEN);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  // Pre-warm AND validate: hit the URL once so the image is generated +
  // cached before the publisher fetches it, and confirm we actually got
  // image bytes. If Pollinations returns a paywall/queue/JSON error,
  // surface it as a tool error so the agent stops immediately instead of
  // handing a dead URL to the publisher and thrashing through retries.
  try {
    const headers = { "User-Agent": "pollinations-mcp/1.0" };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(90_000),
    });
    const ctype = res.headers.get("content-type") || "";
    if (!res.ok || !ctype.startsWith("image/")) {
      const body = await res.text().catch(() => "");
      return {
        content: [
          {
            type: "text",
            text:
              `Image generation unavailable (HTTP ${res.status}, content-type "${ctype}"). ` +
              `Pollinations is gating this request${TOKEN ? "" : " — no POLLINATIONS_TOKEN is set"}. ` +
              `Do NOT retry generation; report that the upstream generator is rate-limited and stop. ` +
              `Response: ${body.slice(0, 200)}`,
          },
        ],
        isError: true,
      };
    }
  } catch (e) {
    return {
      content: [
        {
          type: "text",
          text:
            `Image generation request failed: ${e.message}. The upstream generator (Pollinations) ` +
            `is unreachable or timed out. Do NOT retry; report the failure and stop.`,
        },
      ],
      isError: true,
    };
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
process.stderr.write(
  `pollinations-mcp connected (${process.env.POLLINATIONS_TOKEN ? "token auth" : "anonymous"})\n`,
);
