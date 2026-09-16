#!/usr/bin/env node
/**
 * Moltbook anti-spam challenge solver.
 *
 * WHY THIS EXISTS, because it is not obvious from the outside:
 *
 * Every post, comment and submolt created through Moltbook's API comes back
 * 200 OK with `verification_status: "pending"` and a `verification` object
 * holding an obfuscated math word problem. The content is NOT published until
 * you solve it and POST the answer to /api/v1/verify. There is no error, no
 * warning, and the create call looks like a success.
 *
 * We never did that. 37 posts over three and a half months all sat at
 * "pending", which is to say none of them were ever visible to anyone. The
 * agent was wound down for producing no engagement; it had in fact never
 * published anything at all. Worth remembering the next time a channel looks
 * dead: check that your writes are actually landing before concluding nobody
 * cares.
 *
 * The challenge is deliberately aimed at language models - alternating caps,
 * scattered punctuation, doubled letters, number words rather than digits:
 *
 *   "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE"
 *   -> a lobster swims at twenty meters and slows by five -> 20 - 5 = 15.00
 *
 * It is still only two numbers and one operation, so a parser handles it
 * without an API call. That matters: the art posting path was deliberately
 * stripped of its Anthropic dependency so it could not break when credit ran
 * out, and re-introducing one here would undo that. If the parser cannot read
 * a challenge confidently it says so rather than guessing, and the caller can
 * fall back to a model if one is configured.
 */

const BASE = "https://www.moltbook.com";

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/** Strip the scatter symbols and case games, leaving plain lowercase words. */
export function deobfuscate(text) {
  return String(text)
    .replace(/[^A-Za-z0-9\s]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse runs of a repeated letter, so the obfuscator's doubling
 * ("tWeNn-Tyy" -> "twenntyy") still matches a number word. Applied to both
 * sides of the comparison so genuinely doubled words survive it too.
 */
function collapse(word) {
  return word.replace(/(.)\1+/g, "$1");
}

const COLLAPSED = new Map();
for (const [w, v] of Object.entries({ ...UNITS, ...TENS })) {
  COLLAPSED.set(collapse(w), v);
}

const COLLAPSED_TENS = new Map();
for (const [w, v] of Object.entries(TENS)) COLLAPSED_TENS.set(collapse(w), v);
const COLLAPSED_UNITS = new Map();
for (const [w, v] of Object.entries(UNITS)) COLLAPSED_UNITS.set(collapse(w), v);

function wordToNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const c = collapse(token);
  if (COLLAPSED.has(c)) return COLLAPSED.get(c);

  // The obfuscator inserts and removes hyphens freely, so "twenty-five" can
  // arrive as the single token "twentyfive". Split a tens prefix off and
  // resolve the remainder as a unit before giving up.
  for (const [tens, tv] of COLLAPSED_TENS) {
    if (c.length > tens.length && c.startsWith(tens)) {
      const rest = c.slice(tens.length);
      const uv = COLLAPSED_UNITS.get(rest);
      if (uv !== undefined && uv > 0 && uv < 10) return tv + uv;
    }
  }
  return null;
}

/**
 * Pull the numbers out in order, joining "twenty five" into 25 the way a
 * reader would rather than treating it as two separate operands.
 */
export function extractNumbers(clean) {
  const tokens = clean.split(" ");
  const out = [];
  // Accumulate across adjacent number words so "twenty five" is 25 and "one
  // hundred" is 100, then flush when a non-number word breaks the run. The
  // naive version - take every number word separately - read "one hundred
  // divided by four" as 1 / 4 and produced a confident 0.25. A wrong answer
  // is worse than no answer here: it burns the attempt and the post stays
  // unpublished either way.
  let current = null;
  const flush = () => {
    if (current !== null) out.push(current);
    current = null;
  };

  for (const tok of tokens) {
    const collapsed = collapse(tok);
    if (collapsed === "hundred" || collapsed === "hundred") {
      current = (current === null || current === 0 ? 1 : current) * 100;
      continue;
    }
    if (collapsed === "thousand") {
      current = (current === null || current === 0 ? 1 : current) * 1000;
      continue;
    }
    const n = wordToNumber(tok);
    if (n === null) {
      // "and" sits inside spelled-out numbers ("one hundred and five") as
      // often as it separates clauses, so it must not break a run.
      if (collapsed !== "and") flush();
      continue;
    }
    current = current === null ? n : current + n;
  }
  flush();
  return out;
}

/**
 * Work out the operation from the verb. Ordered most-specific first: "slows
 * by half" is a division, not a subtraction, so the divide patterns are
 * tested before the generic decrease ones.
 */
const OPS = [
  [/\bdivided?\s+by\b|\bsplits?\s+(in|into)\b|\bper\b|\bshared?\s+(by|among)\b/, "/"],
  [/\bmultiplied?\s+by\b|\btimes\b|\bscaled?\s+by\b/, "*"],
  [/\bslows?\s+by\b|\bdecreas\w*\s+by\b|\bdrops?\s+by\b|\bloses\b|\bminus\b|\bless\b|\breduc\w*\s+by\b|\bsubtracts?\b/, "-"],
  [/\bspeeds?\s+up\s+by\b|\bincreas\w*\s+by\b|\bgains\b|\bplus\b|\badds?\b|\bmore\b|\bfaster\s+by\b|\brises?\s+by\b/, "+"],
];

export function extractOperation(clean) {
  for (const [re, op] of OPS) if (re.test(clean)) return op;
  return null;
}

/**
 * Solve a challenge string.
 * @returns {{ok:true, answer:string, a:number, b:number, op:string, clean:string}
 *          | {ok:false, reason:string, clean:string}}
 */
export function solveChallenge(challengeText) {
  const clean = deobfuscate(challengeText);
  const nums = extractNumbers(clean);
  const op = extractOperation(clean);

  if (nums.length < 2) {
    return { ok: false, reason: `found ${nums.length} number(s), need 2`, clean };
  }
  if (!op) return { ok: false, reason: "no operation keyword recognised", clean };

  // More than two numbers means we have misread something. Guessing which
  // pair was intended is how you submit a confident wrong answer, so stop.
  if (nums.length > 2) {
    return { ok: false, reason: `found ${nums.length} numbers (${nums.join(",")}), ambiguous`, clean };
  }

  const [a, b] = nums;
  if (op === "/" && b === 0) return { ok: false, reason: "division by zero", clean };

  const value = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : a / b;
  return { ok: true, answer: value.toFixed(2), a, b, op, clean };
}

/**
 * Solve and submit. Call immediately after creating content - the window is
 * 5 minutes for posts and comments, 30 seconds for submolts.
 *
 * @param verification the `verification` object from the create response
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function solveAndSubmit(verification, { apiKey = process.env.MOLTBOOK_API_KEY } = {}) {
  if (!verification?.verification_code || !verification?.challenge_text) {
    return { ok: false, detail: "no verification object on the response" };
  }
  const solved = solveChallenge(verification.challenge_text);
  if (!solved.ok) {
    return { ok: false, detail: `could not solve: ${solved.reason} | read as: "${solved.clean}"` };
  }

  const res = await fetch(`${BASE}/api/v1/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      verification_code: verification.verification_code,
      answer: solved.answer,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    return {
      ok: false,
      detail: `verify rejected (${res.status}): ${body?.message ?? body?.error ?? "unknown"} | sent ${solved.a} ${solved.op} ${solved.b} = ${solved.answer}`,
    };
  }
  return { ok: true, detail: `${solved.a} ${solved.op} ${solved.b} = ${solved.answer}` };
}

// ---- self-test -------------------------------------------------------------
// `node moltbook-verify.mjs` exercises the parser on the documented example
// plus the shapes it is likely to meet. Solving offline is the only way to
// check this without burning a real post on a 5-minute timer.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/") ||
    process.argv[1]?.endsWith("moltbook-verify.mjs")) {
  const cases = [
    ["A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE, wH-aTs] ThE/ nEw^ SpE[eD?", "15.00"],
    ["a lobster swims at thirty meters and speeds up by four", "34.00"],
    ["ThE cR^aB mO[vEs aT] tWeN-tY fI^vE aNd] iS mUl/tIpLiEd bY^ tWo", "50.00"],
    ["a lobster at one hundred divided by four", "25.00"],
    ["the shrimp travels at twelve and loses three", "9.00"],
    ["a crab at one hundred and five minus five", "100.00"],
    ["A] lObStEr aT/ tW]eNtY-fI^vE sPe[eDs uP bY^ sE-vEn-tY", "95.00"],
    ["a lobster swims at eighteen meters", null], // one number -> refuse
  ];
  let pass = 0;
  for (const [text, want] of cases) {
    const r = solveChallenge(text);
    const got = r.ok ? r.answer : null;
    const ok = got === want;
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}  want=${want ?? "refuse"} got=${got ?? `refuse (${r.reason})`}`);
    if (!ok) console.log(`        read as: "${r.clean}"`);
  }
  console.log(`\n  ${pass}/${cases.length} passed`);
  process.exitCode = pass === cases.length ? 0 : 1;
}
