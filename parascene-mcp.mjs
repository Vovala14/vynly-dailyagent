#!/usr/bin/env node
/**
 * parascene-mcp — image generation via Parascene (the engine Vynly's own
 * /generate uses). One stdio tool, `generate_image`, that generates an image,
 * writes the bytes to a local temp file, and returns the PATH. Pair with
 * @vynly/mcp's vynly_post_image (imagePath field) for a generate -> publish
 * agent.
 *
 * Returns a PATH, not a URL: the Parascene image URL needs the psn_ key to
 * fetch, so we never hand that URL (or the key) to the model / a log.
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
import { generateParasceneImage, extForContentType } from "./lib.mjs";

const HAS_KEY = !!process.env.PARASCENE_API_KEY;

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

const err = (text) => ({ content: [{ type: "text", text }], isError: true });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "generate_image") return err(`Unknown tool: ${req.params.name}`);
  const prompt = typeof req.params.arguments?.prompt === "string" ? req.params.arguments.prompt : "";
  if (!prompt) return err("Error: prompt is required");
  if (!HAS_KEY) return err("PARASCENE_API_KEY is not set. Do NOT retry; report this and stop.");

  let bytes, contentType, nsfw;
  try {
    ({ bytes, contentType, nsfw } = await generateParasceneImage(prompt));
  } catch (e) {
    return err(`${e.message}. Do NOT retry generation; report the failure and stop.`);
  }

  const filePath = join(
    tmpdir(),
    `parascene-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${extForContentType(contentType)}`,
  );
  await writeFile(filePath, bytes);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          imagePath: filePath,
          generator: "grok",
          nsfw: Boolean(nsfw),
          note: "Grok Imagine via Parascene. Pass imagePath to the publish tool's imagePath field; set declaredSource to 'grok'.",
        }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`parascene-mcp connected (${HAS_KEY ? "key set" : "NO KEY — set PARASCENE_API_KEY"})\n`);
