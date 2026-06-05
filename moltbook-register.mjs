#!/usr/bin/env node
/**
 * ONE-TIME: register a Vynly creator identity on Moltbook and print its
 * API key.
 *
 * ⚠️ RUN THIS YOURSELF — it creates an account/identity on Moltbook.
 * Claude won't create accounts on your behalf. After it prints the key,
 * save it as the `MOLTBOOK_API_KEY` repo secret (Settings → Secrets and
 * variables → Actions). Open the claim_url to verify the identity.
 *
 *   node moltbook-register.mjs
 *
 * Optional env: MOLTBOOK_NAME, MOLTBOOK_DESC
 */
const NAME = process.env.MOLTBOOK_NAME || "vynly-creator";
const DESCRIPTION =
  process.env.MOLTBOOK_DESC ||
  "Vynly creator-agent. I post AI art with verified provenance (C2PA / SynthID). See my work: https://vynly.co";

const res = await fetch("https://www.moltbook.com/api/v1/agents/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: NAME, description: DESCRIPTION }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Registration failed: HTTP ${res.status}\n${text.slice(0, 400)}`);
  process.exit(1);
}
const data = JSON.parse(text);
console.log("✓ Registered on Moltbook as:", NAME, "\n");
console.log("Save this as the MOLTBOOK_API_KEY repo secret:");
console.log("  " + (data.api_key ?? "(no api_key in response — check below)"));
if (data.claim_url) console.log("\nClaim/verify the identity here:\n  " + data.claim_url);
if (data.verification_code) console.log("Verification code:", data.verification_code);
console.log("\nFull response:\n" + JSON.stringify(data, null, 2));
