# Ephemeral Chat

Temporary, end-to-end encrypted chat. Pick a username, chat for **10 minutes**, leave.
All messages are wiped from the server **every day at midnight UTC**.

- **Backend:** Django (built-in ORM; SQLite locally, Postgres via `DATABASE_URL` in production)
- **Frontend:** React + Vite
- **Deploy:** Vercel (frontend + API in one project), or Netlify for the frontend + Vercel for the API

## How it works

| Requirement | How it's done |
|---|---|
| Username per session | Chosen on entry, never sent to the server in plain text. It travels inside the encrypted message. A random `#tag` per session stops people from impersonating each other with the same name. |
| 10-minute sessions | `POST /api/session` returns a bearer token valid for 10 minutes. After that every call returns 401 and the UI wipes itself. **Leave & wipe** ends it early. |
| Deleted every day | Every API request first deletes messages from before today (UTC) and expired sessions. A Vercel Cron job (`/api/purge`, 00:01 UTC) does the same. Deletion works even if the cron never runs. |
| End-to-end encryption | The room secret lives only in the invite link's `#fragment`, which browsers never send to servers. The browser derives an AES-GCM key and an opaque room id from it (PBKDF2), so the server only ever stores ciphertext and a hash. |
| No trace | No accounts, cookies, admin, IP or user-agent storage. Request logging is disabled. Only token hashes are stored. Messages are not linked to sessions. Responses are `no-store`. Nothing goes in localStorage, and the secret is stripped from the address bar. |

### Limits on "untraceable"
These limits are worth knowing:
- **Your hosting provider** (Vercel/Netlify) and your database provider keep their own
  request logs, including IP addresses, at the platform level. This app can't turn those off.
  Users who need network anonymity should use Tor or a VPN.
- **Anyone with the invite link can read the room.** Share it only through a channel you trust.
- If you use a typed passphrase instead of a generated link, a weak passphrase can be guessed.
  Generated links are 144-bit random.
- The server can still see timing and size metadata (when ciphertext was posted, and how big it is).

## Run locally

```bash
# Backend (http://127.0.0.1:8000)
pip install -r requirements.txt
cd backend
python manage.py migrate
python manage.py runserver

# Frontend (http://localhost:5173, proxies /api to Django)
cd frontend
npm install
npm run dev
```

Tests:

```bash
cd backend && python manage.py test chat
cd frontend && npm test
```

## Deploy

### Option A: everything on Vercel (recommended)

1. Import the repo into Vercel. `vercel.json` builds the React app and serves Django from `api/index.py` at `/api/*`.
2. Create a Postgres database (Vercel Marketplace → Neon, or Supabase, etc.) and set the environment variables:
   - `DATABASE_URL`: the Postgres connection string
   - `DJANGO_SECRET_KEY`: a long random string
   - `CRON_SECRET`: a long random string (Vercel Cron sends it to `/api/purge`)
   - `AUTO_MIGRATE=1` to create the tables on first start (or run `python manage.py migrate` locally against `DATABASE_URL`)
3. Deploy.

> **Why not SQLite in production?** Serverless functions don't share a disk. SQLite only works
> in `/tmp`, which is separate for each instance and is lost on recycle, so users on different instances wouldn't
> see each other's messages. Without `DATABASE_URL` the app still falls back to SQLite in
> `/tmp`. That's fine for a quick demo, but not reliable.

### Option B: frontend on Netlify, API on Vercel

Netlify Functions can't run Django, so the API still goes on Vercel (Option A steps).
Then:
1. Import the repo into Netlify. `netlify.toml` builds `frontend/`.
2. In Netlify, set `VITE_API_URL=https://<your-api>.vercel.app`.
3. In Vercel, set `CORS_ALLOWED_ORIGINS=https://<your-site>.netlify.app`.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/session` | none, body `{room}` | Start a 10-min session → `{token, expires_at, purge_at, online}` |
| DELETE | `/api/session` | Bearer token | Leave (deletes the session) |
| GET | `/api/messages?after=<id>` | Bearer token | Fetch new ciphertext messages (polled every 2 s) |
| POST | `/api/messages` | Bearer token, body `{data}` | Post a base64 ciphertext message |
| GET/POST | `/api/purge` | Bearer `CRON_SECRET` | Daily cleanup hook |

Real-time updates use polling, because Vercel and Netlify serverless functions don't support WebSockets.

---

## Telecom Knowledge AI (`telecom-ai/`)

This repository also contains **Telecom Knowledge AI**, a separate Next.js application for evidence-grounded
retrieval over 3GPP specifications, telecom source code and API schemas (no LLM; extractive answers with citations).
See [`telecom-ai/README.md`](telecom-ai/README.md). It deploys as its own Vercel project with Root Directory `telecom-ai`.
