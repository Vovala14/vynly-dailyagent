# vynly-dailyagent

[![moltbook-creator](https://github.com/Vovala14/vynly-dailyagent/actions/workflows/moltbook.yml/badge.svg)](https://github.com/Vovala14/vynly-dailyagent/actions/workflows/moltbook.yml)
[![moltbook-engage](https://github.com/Vovala14/vynly-dailyagent/actions/workflows/moltbook-engage.yml/badge.svg)](https://github.com/Vovala14/vynly-dailyagent/actions/workflows/moltbook-engage.yml)

Autonomous agents that **generate AI art and publish it to [vynly.co](https://vynly.co)** — and keep a genuine creator + engagement presence on [Moltbook](https://www.moltbook.com), the social network for AI agents. Running live, on GitHub Actions, every day.

> The copy-paste pattern for *"I want my agent to post what it makes."* Use this repo as a template.

**Live output:**
[a daily post](https://vynly.co/p/mq1iwuxw8f2fwq) · [a Moltbook creator post](https://vynly.co/p/mq1j91e32e646z) · [the agent on Moltbook](https://www.moltbook.com/u/vynly-creator)

---

## What's in here

| File / workflow | What it does | Schedule |
|---|---|---|
| `dailyagent.mjs` | **MCP-to-MCP demo:** a [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) loop that chains a generation MCP (`parascene-mcp.mjs`) into [`@vynly/mcp`](https://github.com/Vovala14/vynly-mcp) — Claude generates an image, then publishes it, with no glue code between the tools. | (disabled by default) |
| `moltbook-agent.mjs` → `moltbook.yml` | **Creator:** generate art → post to Vynly → share that post on Moltbook as a genuine creator (attribution in bio, not link-spam). | daily 16:00 UTC |
| `moltbook-engage.mjs` → `moltbook-engage.yml` | **Engagement:** read the feed, leave a few *substantive* Claude-written comments, upvote + follow real value. Earns karma the legitimate way — **never** promotes Vynly. | daily 18:00 UTC |
| `moltbook-register.mjs` / `moltbook-announce.mjs` | One-time helpers: register the Moltbook identity / post a single skill announcement. | manual |
| `lib.mjs` | Shared Parascene generation + Vynly publishing helpers. | — |

## How it works

Generation runs through **Parascene** (the engine Vynly's own `/generate` uses). The key stays in an `Authorization` header — never in a URL, a log, or a public post. Images upload to Vynly via multipart, so each post carries verified AI provenance and a permanent `vynly.co/p/<id>` URL.

The Moltbook presence is built on one principle: **earn attention, don't farm it.** The creator posts real work; the engager adds real value to others' threads. Promotion stays in the bio. (A brand-new agent dropping promo links gets spam-flagged — we learned that the honest way.)

## Quick start (use as a template)

1. Click **"Use this template"** → create your repo.
2. `npm install`
3. Add repo secrets (**Settings → Secrets and variables → Actions**) — see [`.env.example`](.env.example):
   - `VYNLY_TOKEN` — `DEMO`, or a real token from [vynly.co/settings](https://vynly.co/settings)
   - `PARASCENE_API_KEY` — your `psn_` key (image generation)
   - `ANTHROPIC_API_KEY` — drives the SDK loop + comment writing
   - `MOLTBOOK_API_KEY` — from `npm run moltbook:register` (run once), for the Moltbook presence
4. Set `MOLTBOOK_SUBMOLT` in `moltbook.yml` to a real submolt, then enable the workflows.

**Local preview:** `DRY_RUN=1 npm run moltbook:create` generates + posts to Vynly but skips Moltbook.

## The agent skill

Any agent can self-install Vynly publishing from one pinned, link-safe skill file: **[vynly.co/skill.md](https://vynly.co/skill.md)**. Or add the MCP server directly: `npx -y @vynly/mcp` (in the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.Vovala14/vynly-mcp`).

## License

MIT — see [LICENSE](LICENSE).
