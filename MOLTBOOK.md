# Vynly on Moltbook — genuine participation, not promo spam

Two small tools for having a real Vynly presence on [Moltbook](https://www.moltbook.com)
(the social network for AI agents), built deliberately to **earn** discovery
rather than spam for it.

## The stance (read first)

A bot that DMs/replies "come to vynly.co" at other agents is spam: it violates
Moltbook's rules, gets the account banned, annoys the exact audience you want,
and contradicts Vynly's whole point (verified, trustworthy, not spam). So these
tools **don't do that**. Instead:

- **`moltbook-agent.mjs`** is a *creator* with three rotating post types: **art** (Mon: generate, publish to Vynly, share as image post), **thought** (Wed: a Claude-written discussion post other agents want to argue with - zero promo, zero links), and **studio** (Fri: a practice note that may mention vynly.co once, as plain text, portfolio-style). Attribution stays in the **profile bio** and the linked artwork - never link-spam in other agents' threads. No comments, no replies, no DMs from this script.
- **`moltbook-announce.mjs`** posts **one** genuine, useful announcement about
  the Vynly skill to a relevant submolt. Run it **once**. Repeating it is spam.

If you wouldn't post it as a real creator who finds the pairing useful, it's
not in here.

## Setup (once)

1. **Register the identity (you run this — it creates an account):**
   ```bash
   node moltbook-register.mjs
   ```
   Save the printed `api_key`, open the `claim_url` to verify.

2. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `MOLTBOOK_API_KEY` — from step 1
   - `VYNLY_TOKEN` — already set for the daily agent (or `DEMO`)
   - `POLLINATIONS_TOKEN` — optional but recommended (free; lifts the
     generator rate limit that blocks CI IPs — see the main README)

3. **Pick a real submolt.** Browse moltbook.com, find a submolt that fits AI
   art, and set `MOLTBOOK_SUBMOLT` in `.github/workflows/moltbook.yml`
   (default `art`). A wrong submolt makes posts 404 with a clear error.

4. **(Optional) post the one-time announcement:**
   ```bash
   MOLTBOOK_API_KEY=... MOLTBOOK_SUBMOLT=general node moltbook-announce.mjs
   ```

The `moltbook-creator` workflow then runs daily (16:00 UTC). Trigger it
manually first from the Actions tab to confirm it posts cleanly.

## Rate limits (Moltbook)

1 post / 30 min (1 / 2h for the first 24h), 30 writes/min. The daily cadence
here is far under that on purpose.
