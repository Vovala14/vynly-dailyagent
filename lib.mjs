/**
 * Shared helpers for the Vynly agents: image generation via Parascene and
 * publishing to Vynly. Both the dailyagent generator MCP and the Moltbook
 * creator use these, so the create -> poll -> fetch flow lives in one place.
 */

const PARASCENE_BASE = "https://api.parascene.com";
const VYNLY_BASE = process.env.VYNLY_BASE_URL ?? "https://vynly.co";

/**
 * Generate one image with Parascene and return the raw bytes.
 * Throws on any failure (caller decides whether to skip or fail).
 *
 * @returns {Promise<{bytes: Buffer, contentType: string}>}
 */
export async function generateParasceneImage(prompt, {
  key = process.env.PARASCENE_API_KEY || "",
  model = process.env.PARASCENE_MODEL || "xai/grok-imagine-image",
} = {}) {
  if (!key) throw new Error("PARASCENE_API_KEY not set");
  const auth = { Authorization: `Bearer ${key}` };

  // 1. create the job
  const cres = await fetch(`${PARASCENE_BASE}/api/create`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      server_id: 1,
      method: "replicate",
      args: { model, prompt, input_images: [] },
      creation_token: `crt_vynly_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      hydrate_mentions: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!cres.ok) {
    const b = await cres.text().catch(() => "");
    throw new Error(`Parascene create failed: HTTP ${cres.status} ${b.slice(0, 160)}`);
  }
  const id = (await cres.json())?.id;
  if (!id) throw new Error("Parascene create returned no id");

  // 2. poll until completed (~10s typical)
  let meta = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pres = await fetch(`${PARASCENE_BASE}/api/create/images/${id}`, {
      headers: auth,
      signal: AbortSignal.timeout(20_000),
    });
    if (!pres.ok) continue;
    const pj = await pres.json().catch(() => null);
    if (!pj) continue;
    if (pj.status === "completed") { meta = pj; break; }
    if (pj.status === "failed") throw new Error("Parascene generation failed");
  }
  if (!meta || !meta.url) throw new Error("Parascene generation timed out");

  // 3. fetch the bytes (key in header; URL is on api.parascene.com)
  const imgUrl = meta.url.startsWith("http") ? meta.url : `${PARASCENE_BASE}${meta.url}`;
  const bres = await fetch(imgUrl, { headers: auth, signal: AbortSignal.timeout(60_000) });
  const contentType = bres.headers.get("content-type") || "image/png";
  if (!bres.ok || !contentType.startsWith("image/")) {
    throw new Error(`Parascene image fetch failed: HTTP ${bres.status}`);
  }
  const bytes = Buffer.from(await bres.arrayBuffer());
  return { bytes, contentType, nsfw: Boolean(meta.nsfw) };
}

export function extForContentType(contentType) {
  return contentType.includes("jpeg") || contentType.includes("jpg")
    ? "jpg"
    : contentType.includes("webp")
      ? "webp"
      : "png";
}

/**
 * Publish image bytes to Vynly via multipart (so the source URL / generator
 * key never leaves this process). Vynly re-hosts the image and returns the
 * post object, including the public imageUrl.
 *
 * @returns {Promise<object>} the created Vynly post ({ id, imageUrl, ... })
 */
export async function postImageToVynly(bytes, contentType, caption, {
  token = process.env.VYNLY_TOKEN || "DEMO",
  declaredSource = "grok",
} = {}) {
  const fd = new FormData();
  fd.append("image", new Blob([bytes], { type: contentType }), `art.${extForContentType(contentType)}`);
  if (caption) fd.append("caption", caption);
  if (declaredSource) fd.append("declaredSource", declaredSource);
  const res = await fetch(`${VYNLY_BASE}/api/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vynly post failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export function vynlyPostUrl(post) {
  return `${VYNLY_BASE}/p/${post.id}`;
}
