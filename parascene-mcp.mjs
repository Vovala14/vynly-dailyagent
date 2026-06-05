#!/usr/bin/env node
/**
 * parascene-mcp — image generation via Parascene (the engine Vynly's own
 * /generate uses).  Exposes one stdio tool, `generate_image`, that creates a
 * job, polls until completed, downloads the bytes, writes them to a local
 * temp file, and returns the PATH. Pair with @vynly/mcp's vynly_post_image
 * (imagePath field) for a generate -> publish agent.
 *
 * Returns a PATH, not a URL: the Parascene image URL needs the psn_ key to
 * fetch, so we never hand that URL (or the key) to the model / a log. The
 * publisher reads the local file instead.
 *
 * Env:  PARASCENE_API_KEY  (psn_… personal key)  required
 *       PARASCENE_MODEL    optional, default xai/grok-imagine-image
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

const PARASCENE_KEY = process.env.PARASCENE_API_KEY || "";
const PARASCENE_BASE = "https://api.parascene.com";
const PARASCENE_MODEL = process.env.PARASCENE_MODEL || "xai/grok-imagine-image";

const server = new Server(
  { name: "parascene-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate an image from a text prompt using Parascene (Grok Imagine by default). Returns a local file PATH; pass it to a publishing tool's imagePath field. Requires PARASCENE_API_KEY in the environment.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description: "The image description. Be specific and visual (subject, style, lighting, mood).",
            maxLength: 1500,
          },
        },
      },
    },
  ],
}));

function err(text) {
  return { content: [{ type: "text", text }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "generate_image") {
    return err(`Unknown tool: ${req.params.name}`);
  }
  const prompt = typeof req.params.arguments?.prompt === "string" ? req.params.arguments.prompt : "";
  if (!prompt) return err("Error: prompt is required");
  if (!PARASCENE_KEY) {
    return err("PARASCENE_API_KEY is not set. Do NOT retry; report this and stop.");
  }
  const auth = { Authorization: `Bearer ${PARASCENE_KEY}` };

  let id;
  try {
    const cres = await fetch(`${PARASCENE_BASE}/api/create`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        server_id: 1,
        method: "replicate",
        args: { model: PARASCENE_MODEL, prompt, input_images: [] },
        creation_token: `crt_vynly_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        hydrate_mentions: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!cres.ok) {
      const b = await cres.text().catch(() => "");
      return err(`Parascene create failed (HTTP ${cres.status}): ${b.slice(0, 200)}. Do NOT retry; report and stop.`);
    }
    id = (await cres.json())?.id;
  } catch (e) {
    return err(`Parascene create request failed: ${e.message}. Do NOT retry; report and stop.`);
  }
  if (!id) return err("Parascene create returned no id. Do NOT retry; report and stop.");

  // Poll until completed (~10s typical).
  let meta = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const pres = await fetch(`${PARASCENE_BASE}/api/create/images/${id}`, {
        headers: auth,
        signal: AbortSignal.timeout(20_000),
      });
      if (!pres.ok) continue;
      const pj = await pres.json().catch(() => null);
      if (!pj) continue;
      if (pj.status === "completed") { meta = pj; break; }
      if (pj.status === "failed") return err("Parascene generation failed. Do NOT retry; report and stop.");
    } catch {
      /* transient poll error — keep trying */
    }
  }
  if (!meta || !meta.url) return err("Parascene generation timed out. Do NOT retry; report and stop.");

  // Download bytes and write to a temp file; return the path.
  let buf, ctype;
  try {
    const imgUrl = meta.url.startsWith("http") ? meta.url : `${PARASCENE_BASE}${meta.url}`;
    const bres = await fetch(imgUrl, { headers: auth, signal: AbortSignal.timeout(60_000) });
    ctype = bres.headers.get("content-type") || "image/png";
    if (!bres.ok || !ctype.startsWith("image/")) {
      return err(`Parascene image fetch failed (HTTP ${bres.status}). Do NOT retry; report and stop.`);
    }
    buf = Buffer.from(await bres.arrayBuffer());
  } catch (e) {
    return err(`Parascene image fetch failed: ${e.message}. Do NOT retry; report and stop.`);
  }

  const ext = ctype.includes("jpeg") || ctype.includes("jpg") ? "jpg" : ctype.includes("webp") ? "webp" : "png";
  const filePath = join(tmpdir(), `parascene-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  await writeFile(filePath, buf);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          imagePath: filePath,
          generator: "grok",
          nsfw: Boolean(meta.nsfw),
          note: "Grok Imagine via Parascene. Pass imagePath to the publish tool's imagePath field; set declaredSource to 'grok'.",
        }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `parascene-mcp connected (${PARASCENE_KEY ? "key set" : "NO KEY — set PARASCENE_API_KEY"})\n`,
);
