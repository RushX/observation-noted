# Observation Noted

**Read. Find. Get judged (and better).**

A hands-on trainer for the one GRC skill no framework PDF can teach you: spotting what's *missing* in a policy.

Most compliance training stops at "here is what an access control policy should contain." Observation Noted does the other half — it hands you a realistic but **intentionally flawed** policy document and asks you to find the gaps, then grades your judgment. It's a practice gym for the review skill auditors and GRC professionals actually get hired for.

> Built because there's a real gap between *knowing the frameworks* and *being able to apply them to a messy real-world document.* You don't learn to catch a vague review cadence or a missing control owner by reading about it. You learn by catching it.

<!-- Add a screenshot here once deployed:
![Observation Noted screenshot](docs/screenshot.png)
-->

---

## How it works

1. **Pick a policy type and difficulty.** Access Control, Incident Response, Vendor Risk, Data Retention — at Trainee, Analyst, or Auditor level.
2. **Read the document.** The AI generates a complete, professional-looking policy — company name, document ID, version, sections — with a set number of deliberate flaws hidden inside. Nothing is signposted.
3. **List the gaps you find.** Missing owners, vague language, no review cadence, scope holes, undefined terms — whatever you'd flag in a real review.
4. **Get judged.** An AI examiner scores your findings against a hidden answer key, but on *substance*, not wording:
   - **Recall** — how many real gaps you caught (severity-weighted: high-impact misses cost more).
   - **Precision** — whether your findings were genuine or false alarms.
   - **Bonus** — valid gaps you spotted that the key didn't even list get full credit.
5. **Learn.** See exactly what you missed and reveal the full answer key.

Time is tracked, but shown as context only — thoroughness beats speed in real policy review, so it isn't part of the score.

## Why grade on substance, not keyword-matching

A naive version would check your answers against a fixed list and mark you wrong for finding a real problem that wasn't on it. Observation Noted's examiner judges each finding on its merits against the actual document, so a valid observation the answer key missed still earns credit. That's the harder, more honest version of the idea — and the part worth getting right.

## Tech stack

- **Frontend:** React + Vite
- **AI:** Google Gemini (`gemini-2.5-flash`)
- **Proxy:** a tiny Node serverless function that keeps the API key server-side (never shipped to the browser)
- **Hosting:** Vercel (free tier)

## Run it locally

You'll need Node 20.19+ (or 22+) and a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
# 1. Clone and install
git clone https://github.com/RushX/observation-noted.git
cd observation-noted
npm install

# 2. Add your key — create a file named .env in the project root:
#    GEMINI_API_KEY=your_key_here
#    (.env is gitignored and never committed)

# 3. Start the local key-proxy server (terminal 1)
node server.js

# 4. Start the frontend (terminal 2)
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). You need both terminals running — `server.js` handles the AI calls, `npm run dev` serves the app.

## Deploy (Vercel)

1. Push to GitHub and import the repo at [vercel.com](https://vercel.com). Vercel auto-detects Vite.
2. In **Settings → Environment Variables**, add `GEMINI_API_KEY` with your key.
3. Deploy. The serverless function in `api/gemini.js` keeps your key safe; `server.js` is only for local dev.

> Your API key powers every visitor's requests, so `api/gemini.js` includes basic per-IP rate limiting. For real traffic, move it to a shared store (Vercel KV / Upstash).

## Roadmap

- A **vetted policy bank** — hand-reviewed scenarios with locked answer keys, so scores mean the same thing for everyone.
- A **contributor format** — submit your own flawed policy + answer key as a folder, so GRC practitioners can add scenarios.
- More policy types and frameworks (SOC 2, ISO 27001, NIST mappings).
- Eventually: the same engine, other domains — finance, legal, clinical. The skill ("find what's missing") is universal.

## Contributing

Ideas, flawed-policy scenarios, and bug reports are welcome — open an issue or a PR. The most useful contribution right now is a well-crafted flawed policy with its answer key.

## License

[MIT](LICENSE) — use it, fork it, learn from it.

## Author

Built by **Rushikesh Muley**, who reads the policy nobody else reads.

[GitHub](https://github.com/RushX) · [LinkedIn](https://www.linkedin.com/in/RushikeshMuley)
