# Expense Tracker 💰

A personal finance tracker for the **Ghanaian Cedi (₵ / GHS)** with user accounts, persistent storage, and an optional AI advisor. Premium fintech UI with light/dark themes — built as a single-page app on a tiny zero-bloat Node backend.

![Tab: Log · Overview · Recon · Wishlist · Advisor](https://img.shields.io/badge/tabs-5-2dd4a8) ![Node](https://img.shields.io/badge/node-%E2%89%A518-339933) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Log** — record income and expenses across six categories
- **Overview** — monthly drawdown bar, category donut, daily-spend chart, and a category breakdown
- **Recon** — bank-statement-style ledger with a running balance
- **Wishlist** — track wanted items by priority; "mark as bought" can log it as an expense
- **Advisor** — *(optional)* Claude-powered tips: monthly summary, savings, trends, budget plan, wishlist advice
- **User accounts** — register/log in; each user's data is private and stored server-side
- **Light / dark theme**, fully responsive

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/GLartey97/expense-tracker.git
cd expense-tracker
npm install
npm start
```

Then open **http://localhost:5173**, create an account, and start tracking.

## Deploy (free, for phone install)

To install it on a phone you need a public HTTPS URL. The repo includes a Render Blueprint:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/GLartey97/expense-tracker)

1. Click the button (or go to [render.com](https://render.com) → **New → Blueprint** and pick this repo). Sign in with GitHub.
2. Render reads `render.yaml`, creates a free web service, builds, and gives you a URL like `https://expense-tracker-xxxx.onrender.com`.
3. **For accounts that persist, add a database** (strongly recommended on Render free):
   - Create a free Postgres database at [neon.tech](https://neon.tech) and copy its connection string.
   - In the Render service's **Environment** tab, add `DATABASE_URL` = that connection string.
   - The app auto-detects it and stores everything in Postgres instead of the (ephemeral) file.
4. (Optional) Also add `ANTHROPIC_API_KEY` to enable the Advisor.

> Free tier notes: the service **sleeps after ~15 min idle** (first request then takes ~50s to wake). Its disk is **ephemeral** — without `DATABASE_URL`, `data/db.json` resets on each restart/redeploy and everyone gets logged out. Setting `DATABASE_URL` (Neon) fixes this completely and keeps accounts permanent.

## Install on your phone (PWA)

This is a Progressive Web App — once it's hosted over HTTPS, anyone can install it like a native Android app:

1. Open the site in **Chrome on Android**.
2. Tap the **⋮ menu → "Add to Home screen"** (or accept the install banner).
3. It launches full-screen with its own icon — no Play Store needed.

On iOS, use **Share → Add to Home Screen** in Safari. The UI shell is cached for offline launch; viewing your data still needs a connection.

## The AI Advisor (optional)

The four core tabs work with **no setup**. The **Advisor** tab calls the [Claude API](https://www.anthropic.com), which is pay-as-you-go and separate from any Claude.ai subscription. To enable it:

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) and add a little billing credit.
2. Copy `.env.example` to `.env` and paste your key:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart the server (`npm start`).

Without a key, the Advisor tab simply shows a "not configured" notice — nothing else is affected.

## How it works

- **Frontend** — a single `index.html` (Chart.js + Lucide icons via CDN). No build step.
- **Backend** — `server.js` runs on Node's built-in `http` module. The only dependency is the official `@anthropic-ai/sdk`, used solely for the Advisor.
- **Auth** — passwords are hashed with scrypt; sessions are random httpOnly cookies.
- **Storage** — per-user data persists to `data/db.json` (created on first run, git-ignored).

```
expense-tracker/
├── index.html      # the app (auth-guarded)
├── login.html      # register / sign-in page
├── server.js       # accounts + per-user data + Advisor proxy
├── package.json
└── data/db.json    # created at runtime (git-ignored)
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | _(unset)_ | Enables the Advisor tab |
| `DATABASE_URL` | _(unset)_ | Postgres connection string; without it data lives in `data/db.json` |
| `RESEND_API_KEY` | _(unset)_ | Enables the "Forgot password" email flow |
| `APP_URL` | `RENDER_EXTERNAL_URL` | Public base URL used in reset links |
| `MAIL_FROM` | `onboarding@resend.dev` | Sender address for recovery emails |
| `PORT` | `5173` | Port the server listens on |

Set these in a `.env` file (see `.env.example`) or your environment.

## Tests

```bash
npm test
```

No dependencies to install — the suite spawns `server.js` on a random port
against a throwaway database and drives it over real HTTP, so it exercises the
actual endpoints rather than a re-implementation of them. It covers accounts and
sessions, password change, login rate limiting, the per-entry write endpoints
(including the cross-device overwrite this app used to suffer from), the
`/api/data` allowlist, the whole reset-token lifecycle with a stubbed mail
provider, and the security headers and static-file guard.

Recovery tests point the server at a local catcher via `RESEND_URL`, so nothing
is ever emailed. `.github/workflows/test.yml` runs the same command on every
push and pull request.

One gap worth knowing about: the backup import/merge and de-duplication logic
lives in an inline `<script>` inside `mobile.html`, so `node --test` can't import
it. That path is still only covered by manual testing.

## Security notes

- `data/` and `.env` are git-ignored — never commit user data or your API key.
- Passwords are never stored in plaintext (scrypt with per-user salt).
- Reset tokens are stored as SHA-256 hashes and are single-use, so a leaked
  database can't be used to take over accounts.
- The server never serves its own source, `package.json`, `data/`, `test/` or
  dotfiles, and sends a tight CSP plus `nosniff`, `Referrer-Policy` and
  `X-Frame-Options: DENY` on every response.
- This is designed for personal/self-hosted use. If you deploy it publicly, put it behind HTTPS (e.g. a reverse proxy) so session cookies travel securely.

## License

[MIT](LICENSE)
