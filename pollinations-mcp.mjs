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
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pollinations rebuilt its API: base is now https://gen.pollinations.ai and
// it requires an sk_ key. We fetch the BYTES with the key in the header and
// write them to a local temp file, returning the PATH (not a URL). The
// publisher reads the file via its imagePath field — so the key never ends
// up in a URL, a tool result sent to the model, or a CI log.
const POLLINATIONS_KEY =
  process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_TOKEN || "";

const server = new Server(
  { name: "pollinations-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate an image from a text prompt using Pollinations.ai (Flux). Returns a local file PATH to the generated image; pass that path to a publishing tool's imagePath field. Requires POLLINATIONS_API_KEY in the environment.",
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

  if (!POLLINATIONS_KEY) {
    return {
      content: [
        {
          type: "text",
          text:
            "POLLINATIONS_API_KEY is not set. Get a key at enter.pollinations.ai and set it in the environment. " +
            "Do NOT retry; report this and stop.",
        },
      ],
      isError: true,
    };
  }

  const params = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
  });
  // Key goes in the Authorization header, never in the URL.
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`;

  let buf, ctype;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${POLLINATIONS_KEY}`,
        "User-Agent": "pollinations-mcp/2.0",
      },
      signal: AbortSignal.timeout(120_000),
    });
    ctype = res.headers.get("content-type") || "";
    if (!res.ok || !ctype.startsWith("image/")) {
      const body = await res.text().catch(() => "");
      return {
        content: [
          {
            type: "text",
            text:
              `Image generation failed (HTTP ${res.status}, content-type "${ctype}"). ` +
              `Do NOT retry generation; report the failure and stop. Response: ${body.slice(0, 200)}`,
          },
        ],
        isError: true,
      };
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return {
      content: [
        {
          type: "text",
          text:
            `Image generation request failed: ${e.message}. The generator (Pollinations) ` +
            `is unreachable or timed out. Do NOT retry; report the failure and stop.`,
        },
      ],
      isError: true,
    };
  }

  // Write to a local temp file and return its PATH (keeps the key out of any
  // URL / tool result / log; the publisher reads it via imagePath).
  const ext = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : "jpg";
  const filePath = join(tmpdir(), `pollinations-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  await writeFile(filePath, buf);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          imagePath: filePath,
          generator: "flux",
          note: "Flux via Pollinations. Pass imagePath to the publish tool's imagePath field; set declaredSource to 'flux'.",
        }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `pollinations-mcp connected (${POLLINATIONS_KEY ? "key set" : "NO KEY — set POLLINATIONS_API_KEY"})\n`,
);
