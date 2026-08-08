# Torento — Google sign-in + Drive offload setup

Torento now requires signing in with Google. Every download is streamed to
local disk only transiently, uploaded to **the signed-in user's own Google
Drive**, verified, and then deleted locally — so the droplet stays empty and
your library lives in your (multi-terabyte) Drive. Playback streams back from
Drive on demand.

One person (the **owner**) connects their Google Drive; they can invite others
by email to share the same library (see "Sharing your library" below). Anyone
not invited who signs in gets their own separate, empty space.

## 1. Create Google OAuth credentials

1. Go to <https://console.cloud.google.com> and create (or pick) a project.
2. **APIs & Services → Enabled APIs → + Enable APIs** → enable **Google Drive API**.
   (Optionally enable **Google Picker API** if you later want the visual folder picker.)
3. **OAuth consent screen**
   - User type: **External**.
   - Add your app name / support email.
   - **Scopes**: add `openid`, `email`, `profile`, and
     `https://www.googleapis.com/auth/drive.file`.
   - **Test users**: add every Google account that will sign in (required while
     the app is in "Testing" — or publish the app for wider access).
4. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorized redirect URI**: this must exactly equal `APP_URL` + `/api/auth/callback`.
     - Local: `http://localhost:3000/api/auth/callback`
     - Droplet: `https://your-domain/api/auth/callback`
   - Copy the **Client ID** and **Client secret**.

> Why `drive.file` and not full `drive`? `drive.file` only lets Torento touch
> files and folders it creates (or that you explicitly pick). It cannot read
> the rest of your Drive — the least-privilege, most private option.

## 2. Fill in `.env`

Copy `.env.example` to `.env` and set at least:

```
APP_URL=http://localhost:3000            # your real https URL in production
NODE_ENV=production                      # on the droplet (enables Secure cookies)
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
SESSION_SECRET=<64 hex chars>
TOKEN_ENCRYPTION_KEY=<64 hex chars>
ALLOWED_EMAILS=you@gmail.com,friend@gmail.com   # optional; empty = anyone can sign in
```

Generate the two secrets:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- `SESSION_SECRET` signs the login cookie. Rotating it logs everyone out.
- `TOKEN_ENCRYPTION_KEY` encrypts stored Google refresh tokens at rest
  (AES-256-GCM). Rotating it forces every user to reconnect Drive.

## 3. Run

```
npm install
npm start
```

Open `APP_URL`, click **Continue with Google**, approve access. On first sign-in
Torento grants offline Drive access and (on the first download) auto-creates a
folder named by `DRIVE_DEFAULT_FOLDER` (default `Torento`). Use the account menu
→ **Change destination folder** to create or switch to a different folder.

## How offload works

1. You queue/play a torrent → it downloads to `CACHE_DIR` (transient staging).
2. As each video file completes, it's uploaded to your Drive folder and
   size-verified.
3. Once verified (and nothing is actively streaming it), the local copy is
   deleted to free droplet space.
4. Playback and downloads are served straight from Drive via HTTP range
   requests; if a file is still staging locally it plays from disk/torrent.

## Sharing your library (household)

You can let other people use your library without them connecting their own
Drive — everything stays in **your** Drive folder, streamed through **your**
connection.

1. Sign in and connect Drive (you become the library **owner**).
2. Account menu → **Manage members** → add the person's Google email
   (e.g. your wife's Gmail).
3. They open the app, click **Continue with Google**, and sign in with **that**
   email. They're now in your shared space and see the same library.

Members can **browse, stream, and add downloads** (new downloads upload into
your folder using your connection, so they count against your Drive quota).
Members **cannot** remove items, change the folder, disconnect Drive, or manage
other members — only the owner can. Remove someone anytime from **Manage
members**; they revert to their own empty space.

> Note: since members ride on your Drive connection, keep `ALLOWED_EMAILS`
> (if set) inclusive of everyone you invite, or leave it empty and rely on the
> members list to control who sees what. Invited members can always sign in even
> if they aren't in `ALLOWED_EMAILS`.

## Data & security notes

- `data/` holds `users.json` (with **encrypted** refresh tokens), `spaces.json`,
  and per-space queues. It is gitignored — never commit it, and back it up privately.
- All `/api/*` and `/stream/*` routes require a valid session; the login page is
  the only thing an unauthenticated visitor can load.
- Set `ALLOWED_EMAILS` on any internet-facing instance so only you (and people
  you list) can sign in.
- Behind a reverse proxy, terminate TLS and forward to `PORT`; keep
  `NODE_ENV=production` so the session cookie is `Secure`.
- **Never put the OAuth client secret in a tracked file** (README/SETUP/code) —
  only in `.env`. If it lands in one, rotate it in Google Cloud Console.

## This deployment

- **Domain:** `https://vid.notreal.mv` → set `APP_URL=https://vid.notreal.mv`
  and `NODE_ENV=production` in `.env`.
- **Google redirect URI to register:** `https://vid.notreal.mv/api/auth/callback`
  (must match exactly in the Google Cloud OAuth client's Authorized redirect URIs).
- **Credentials live in `.env`** (gitignored), never in this file. The OAuth
  client was created 2026-07-15 in Google Cloud Console.
- **Process manager:** pm2:
  ```
  pm2 list                 # find the torento process
  pm2 restart torento      # apply .env changes
  pm2 logs torento         # tail logs
  ```
  pm2 does not read `.env` itself — Torento loads it via dotenv, so start the
  process from the project directory (or point pm2 at an ecosystem file).
