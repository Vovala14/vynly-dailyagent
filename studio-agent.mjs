#!/usr/bin/env node
/**
 * Themed studio agents for Vynly.
 *
 * Four small agents that each post one image a day in a fixed subject area:
 * landscape, acrylic painting, wildlife, and fine-art styles. They exist to
 * change what the feed looks like. Vynly's library was only ~9% flagged
 * NSFW, but the visible mix skewed heavily toward figure work, which is what
 * made first-time visitors read it as an adult site.
 *
 * Two deliberate constraints, both about that:
 *
 *   1. NO HUMAN FIGURES in any prompt. Not "no nudity" - no people at all.
 *      Sexualised output is overwhelmingly figure work, so the reliable fix
 *      is to not generate figures rather than to filter them afterwards.
 *   2. A result the generator itself marks nsfw is SKIPPED, not posted.
 *      Belt and braces: Vynly moderates on upload anyway, but an agent whose
 *      whole job is to make the feed calmer should never be the thing that
 *      needs moderating.
 *
 * These post under their own handles and are labelled "via agent" in the UI
 * automatically, because they authenticate with agent tokens. They are not
 * pretending to be people.
 *
 * Env:
 *   STUDIO_THEME        one of: landscape | acrylic | wildlife | artstudy
 *   VYNLY_TOKEN         that theme's agent token
 *   PARASCENE_API_KEY   image generation
 *   STUDIO_COUNT        optional, posts per run (default 1, max 3)
 */
import {
  generateParasceneImage,
  postImageToVynly,
  vynlyPostUrl,
} from "./lib.mjs";

/**
 * Subject banks. Every entry is a scene with no person in it.
 *
 * Written as full prompts rather than assembled from fragments: the
 * combinatorial approach produced a lot of near-identical images, and a feed
 * of obvious variations reads as botted even when the subject is harmless.
 */
const THEMES = {
  landscape: {
    tags: "nature,landscape,aiart",
    prompts: [
      "a misty pine forest at first light, low fog threading between trunks, shafts of pale sun",
      "black basalt sea stacks under a flat grey sky, long-exposure water gone to silk",
      "a braided glacial river seen from high above, grey silt channels on dark gravel",
      "an alpine meadow after rain, wet granite, scattered yellow wildflowers, cloud shadow moving across",
      "a salt flat at dusk, thin water film making a perfect mirror of a violet sky",
      "an old-growth temperate rainforest, moss over fallen logs, deep green shade",
      "chalk cliffs above a cold sea, gulls, grass bent flat by wind",
      "a frozen lake with pressure ridges cracking across it, low winter sun",
      "terraced rice fields in early morning haze, water catching the light",
      "a dry riverbed in red rock country, layered sandstone walls, hard midday shadow",
      "dunes at sunrise, wind-carved ripples, a single line of tracks along a crest",
      "a birch stand in late autumn, white trunks against wet black ground",
    ],
  },
  acrylic: {
    tags: "acrylic,painting,art",
    prompts: [
      "thick impasto acrylic painting of a harbour at dusk, palette-knife strokes, visible ridges of paint",
      "acrylic still life of lemons and a blue ceramic jug, heavy texture, warm ground showing through",
      "abstract acrylic pour, teal and ochre cells bleeding into each other on raw canvas",
      "acrylic study of a rain-slicked street at night, loose wet-into-wet, reflected neon smeared",
      "palette-knife acrylic of a wheat field under a heavy sky, thick horizontal strokes",
      "acrylic painting of a greenhouse interior, dense foliage, light through dirty glass",
      "loose acrylic sketch of a fishing boat hauled up on shingle, limited palette",
      "acrylic landscape in a restricted palette of payne's grey and raw sienna, broad confident strokes",
      "textured acrylic of autumn woodland, dry brush over a dark underpainting",
      "acrylic study of cut flowers in a jam jar on a windowsill, thick white highlights",
      "abstract acrylic colour field, soft edges, layered washes over a heavy gesso ground",
      "acrylic painting of a stormfront over farmland, knife-laid clouds, small bright horizon",
    ],
  },
  wildlife: {
    tags: "animals,wildlife,aiart",
    prompts: [
      "a red fox curled asleep in fresh snow, backlit, breath visible, shallow depth of field",
      "a barn owl mid-glide low over a winter field at dusk, wings fully spread",
      "a pair of otters on a river rock, wet fur, water beading, early light",
      "an Arctic hare motionless in snow, ears flat, almost invisible against the ground",
      "a kingfisher on a reed stem above still water, sharp reflection below",
      "a herd of elephants crossing a dry pan at golden hour, long shadows, dust",
      "a leopard asleep along a horizontal branch, legs hanging, dappled shade",
      "a puffin colony on a sea cliff, birds coming in to land, grey Atlantic behind",
      "a stag in bracken at dawn, mist to shoulder height, antlers catching light",
      "a hummingbird hovering at a trumpet flower, wings blurred, everything else sharp",
      "a green sea turtle over a shallow reef, sunlight caustics rippling across its shell",
      "a pack of wolves moving through deep snow in a treeline, single file",
    ],
  },
  artstudy: {
    tags: "art,illustration,aiart",
    prompts: [
      "ukiyo-e woodblock print of a mountain pass in driving rain, flattened colour, visible grain",
      "art nouveau poster of a botanical garden, ornamental border, muted greens and gold",
      "a Dutch golden age still life of books, a globe and a pewter plate, single light source",
      "bauhaus geometric composition in primary colours, hard edges, careful negative space",
      "a botanical plate of ferns in the style of a 19th century field guide, annotated, aged paper",
      "constructivist poster composition, diagonal blocks of red and black, bold sans type shapes",
      "a woodcut of a harbour town, heavy black line, white gouged highlights",
      "art deco travel poster of a mountain railway, flat planes, strong symmetry",
      "an ink and wash study of bamboo in wind, economy of stroke, lots of empty paper",
      "a mid-century children's book illustration of a forest at night, limited spot colours",
      "an illuminated manuscript margin of vines and birds, gold leaf, deep lapis",
      "a stained glass window design of a tree in four seasons, heavy leading, jewel colours",
    ],
  },
};

const theme = (process.env.STUDIO_THEME || "").trim().toLowerCase();
const cfg = THEMES[theme];
if (!cfg) {
  console.error(
    `STUDIO_THEME must be one of: ${Object.keys(THEMES).join(", ")} (got "${theme}")`,
  );
  process.exit(1);
}
if (!process.env.VYNLY_TOKEN) {
  console.error("VYNLY_TOKEN not set");
  process.exit(1);
}

const count = Math.max(1, Math.min(3, Number(process.env.STUDIO_COUNT || "1")));

/**
 * Caption: the prompt's own subject, trimmed to a phrase, plus the theme
 * tags. Not a fake human aside ("loved making this one!") - the post is
 * badged as an agent, so writing it as if a person made it is the thing that
 * would actually be dishonest.
 */
function captionFor(prompt) {
  const subject = prompt.split(",")[0].trim();
  const text = subject.charAt(0).toUpperCase() + subject.slice(1);
  return `${text}\n\n#${cfg.tags.split(",").join(" #")}`;
}

async function main() {
  const pool = [...cfg.prompts];
  let posted = 0;
  const failures = [];

  for (let i = 0; i < count && pool.length > 0; i++) {
    const prompt = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    try {
      const { bytes, contentType, nsfw } = await generateParasceneImage(prompt);

      // The generator's own verdict. An agent whose job is to make the feed
      // calmer must never be the thing that trips moderation.
      if (nsfw) {
        console.log(`::warning::skipped an nsfw-flagged result for "${prompt.slice(0, 48)}"`);
        continue;
      }

      const post = await postImageToVynly(bytes, contentType, captionFor(prompt), {
        tags: cfg.tags,
      });
      posted++;
      console.log(`[${theme}] posted ${vynlyPostUrl(post)} - ${prompt.slice(0, 60)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(msg);
      console.log(`[${theme}] failed: ${msg}`);
    }
  }

  // A run that posted nothing because everything errored is not a success.
  // Without this the workflow goes green on a totally broken generator, which
  // is how the Moltbook agents quietly did nothing for weeks.
  if (posted === 0 && failures.length > 0) {
    console.log(`::warning::[${theme}] posted nothing; ${failures.length} failure(s): ${failures[0]}`);
    process.exitCode = 1;
  }
  console.log(`[${theme}] done: ${posted} posted, ${failures.length} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
