# Mobile view (`mobile.html`)

A phone-shaped view of the tracker in the **Nocturne** dark design system,
implemented from the Claude Design artboard
`Expense Tracker Mobile.dc.html` (project `f0bb31fb-…`). It folds the five
desktop tabs into four phone tabs plus a centre capture button.

Tracks the artboard as of **2026-09-22**, which added the Settings screen
(editable categories, currency, password) reached from the gear on Home.

## Where it goes

Drop **`mobile.html`** in the **repo root**, next to `index.html` and
`login.html`. `server.js`'s `serveStatic()` already serves any root file,
so it is live at **`/mobile.html`**.

**`server.js`** is also included here — it is `main` plus the new
`/api/password` route (24 added lines, one header comment updated).
Diff it before committing in case `main` has moved on.

```
expense-tracker/
├── index.html
├── login.html
├── mobile.html      ← add this
├── server.js        ← replace (adds POST /api/password)
├── manifest.webmanifest
├── sw.js
└── …
```

Single self-contained file — CSS and JS inlined, Inter from Google Fonts —
matching the convention of `index.html` / `login.html`. No build step, no
new dependencies.

### Optional wiring

- **Link it from `index.html`** (e.g. a "Phone view" link, or redirect
  small viewports): `<a href="/mobile.html">`.
- **PWA**: it already sends `theme-color`, `apple-mobile-web-app-*` and
  links `/manifest.webmanifest`. It does **not** register `/sw.js` itself —
  the service worker registered by `index.html` controls `/mobile.html`
  too once its scope is `/`. Add `mobile.html` to the SW precache list if
  you want it available offline as an installed app.
- **The bell** in the header is decorative (as in the artboard). The gear
  next to it opens Settings.

## Settings

Gear on Home → Settings, with two sub-screens (back button returns one
level, then to Home).

| Section | Behaviour |
| --- | --- |
| **Categories** | Rename, recolour (8-swatch Nocturne ramp) or delete. Renaming **rewrites `category` on every expense** so totals follow the name. Deleting is refused while entries still use the category, or when only two remain. Adding rejects case-insensitive duplicates. |
| **Currency** | GHS / USD / EUR — swaps the symbol app-wide (balance, ledger, keypad, CSV). It does **not** convert historic amounts; nothing here knows a rate. |
| **Month starts on** | Pay-cycle day 1–28. Stored and shown, but the month window is still the calendar month — same as the artboard, which also only stores it. |
| **Face ID / Two-factor** | Stored preferences only; no platform integration behind them yet. |
| **Hide amounts** | The privacy mask. Also still toggled by tapping the balance on Home. |
| **Drawdown card on home** | Shows/hides the monthly progress card. |
| **Export transactions** | CSV of this month (`expenses-YYYY-MM.csv`, BOM + CRLF for Excel). |
| **Export backup** | One JSON with expenses, income, wishlist, categories and prefs. |
| **Import from another device** | Merges a backup file — see below. |
| **Change password** | Fully live against `POST /api/password` — see below. |
| **Sign out** | Real: `POST /api/logout`, then `/login.html`. |
| **Delete account** | Deliberately **not** wired. |

### Backup and import

`Export backup` writes `expense-tracker-backup-YYYY-MM-DD.json`:

```json
{ "app": "expense-tracker", "format": 1, "exportedAt": "…",
  "expenses": [], "income": [], "wishlist": [], "categories": [], "prefs": {} }
```

`Import from another device` **merges** it. Rules worth knowing:

- **Nothing is deleted.** Duplicates are skipped, so re-importing the same
  file is a no-op. Dedup keys: expenses `date+amount+category+desc`, income
  `date+amount+source`, wishlist `name+price`, categories by name
  (case-insensitive).
- **IDs are reassigned.** Two devices both seed ids from `Date.now()`, so
  imported rows get fresh ids — and an expense's `fromWish` link is remapped
  to the wishlist item's new id, keeping Mark bought / Restore working.
- **Preferences are not applied.** They ride along in the file so the backup
  is complete, but changing someone's currency or toggles on import would be
  a surprise. The result card says so.
- Accepts a file (`<input type="file">`) or pasted JSON. The paste box is the
  fallback for anywhere the picker misbehaves.
- Rejects with a specific message: non-JSON, a JSON array, a backup whose
  `app` is something else, or a file with none of the four data keys.

Note this is a *merge*, not a restore — there is deliberately no "replace
everything" path, since that can destroy data and the merge covers the
move-to-a-new-device case.

### Change password — `POST /api/password`

Added to `server.js` alongside `/api/login`. Takes `{current, next}` on an
authenticated session and returns `{ok:true}`.

| Case | Response |
| --- | --- |
| No session | `401 Not signed in` |
| `current` wrong | `401 Current password is wrong.` |
| `next` < 8 chars or has no digit | `400 New password needs 8+ characters and a number.` |
| `next` same as `current` | `400 That is already your password.` |
| OK | `200 {ok:true}` |

Two things it does deliberately:

- **Re-checks the current password.** Holding a session cookie is not
  enough to take the account over.
- **Invalidates every other session** for that user and keeps the calling
  one — so a stolen cookie dies with the change, and the screen's promise
  that "you will stay signed in on this device" holds. Other devices get
  signed out and must log in again.

Note the rule mismatch: `/api/register` still accepts 6-character
passwords, while a *change* requires 8 plus a digit. That is intentional
(raising the bar going forward), but worth aligning if you touch register.

There is no rate limiting, matching `/api/login`. Less pressing here since
the endpoint already requires a valid session, but it is the obvious next
hardening step for both.

## Backend contract used

Same endpoints and shapes as `index.html`:

| Call | Use |
| --- | --- |
| `GET /api/me` | detect a signed-in session; 401 shows a "Sign in" pill linking `/login.html` |
| `GET /api/data` | load `cowork_expenses_v1`, `cowork_income_v1`, `cowork_wishlist_v1`, `cowork_categories_v1`, `cowork_prefs_v1` |
| `POST /api/data` `{key,value}` | persist after every change |
| `POST /api/advice` `{prompt}` → `{text}` | Advisor answers |
| `POST /api/logout` | Sign out |
| `POST /api/password` `{current,next}` | Change password (added to `server.js`) |

- **Object shapes** are unchanged: expense `{id,date,amount,category,desc}`,
  income `{id,date,amount,source}`, wishlist
  `{id,name,price,priority,notes,bought,boughtDate}`. Wishlist buys that
  auto-log an expense also carry `fromWish: <wishId>` so *Restore* can
  remove exactly that entry.
- **New keys** this view owns: `cowork_categories_v1` (array of
  `{name,color}`) and `cowork_prefs_v1` (object of
  `{currency,startDay,biometric,twoFactor,notify,privacy,drawdown}`). Both
  are validated on load, so a malformed row can't take the screen down; bad
  categories fall back to the six seeds. `index.html` ignores both, and the
  six seed categories match the ones it already uses — so renaming a
  category in the mobile view makes the two views disagree until the
  desktop app learns the same key.
- **Offline / signed-out**: falls back to `localStorage` (same keys), and
  if there's no data at all it loads a September 2026 demo dataset so the
  screen is never empty. The Advisor shows sample copy offline and calls
  Claude when signed in.
- **Month scope**: all figures are for the current calendar month
  (`YYYY-MM`); the demo dataset pins to `2026-09`.

## Deliberate departures from the artboard

- **No fake status bar.** The artboard renders inside an `IOSDevice` frame
  that paints one; a real page leaves that to the OS, so this uses
  `env(safe-area-inset-*)`. On wide screens it shows inside a device frame.
- **Recon running balance** accumulates from the opening figure oldest
  entry first (last row = closing balance). The artboard accumulated
  newest-first, which produced negative mid-statement figures.
- **Design tweaks** (`showDrawdown` / `privacyMode` / `monthlyIncome`) are
  now real settings: the artboard's canvas toggles became the *Drawdown
  card on home* and *Hide amounts* switches. Income still falls back to
  ₵6,200 when none is logged (the `monthlyIncome` tweak's default).
- **Password submit is honest.** The artboard's form always "succeeds";
  this one calls the server and reports the real outcome, because the
  account here is real. A change also signs out your other devices.
- **Profile card** shows the signed-in username rather than the artboard's
  hardcoded `glartey@gmail.com` — `/api/me` returns no email.
- **Delete account** and **profile Edit** say they aren't available rather
  than pretending; the artboard toasts "not wired up in this prototype".
- Fonts stay **Inter** (Nocturne's face), not the app's Plus Jakarta Sans /
  Space Grotesk — this view is a distinct design system by intent.
