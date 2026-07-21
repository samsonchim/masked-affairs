# Masked Affairs — Backend

This project adds a minimal Express backend and a Vercel serverless wrapper to accept competition entries from the frontend.

Quick notes:
- Local dev: data is stored in `data/submissions.json` (file-based storage, fine for testing).
- Vercel: the filesystem is ephemeral — use an external database for production (Vercel Postgres, MongoDB Atlas, Supabase, etc.).

Local usage:

```bash
npm install
npm run dev
# open http://localhost:3000/index.html or serve the folder
```

Deploy to Vercel:
1. Install the Vercel CLI or use the Vercel web UI.
2. Ensure `api/submit.js` exists (it wraps the Express app with `serverless-http`).
3. Deploy — on Vercel the function will run as a serverless function. For persistent storage configure an external DB and modify `app.js` to write to it.

Environment variables for production (recommended):
- `MONGODB_URI` — MongoDB connection string
- or configure Vercel Postgres / Supabase credentials

Supabase setup:

- Create a `submissions` table with columns matching the payload, for example:
  - `id` (bigint or serial primary key)
  - `receivedAt` (timestamptz)
  - `category` (text)
  - `name` (text)
  - `department` (text)
  - `level` (text)
  - `imageName` (text)
  - `reason` (text)

- Provide Supabase credentials as environment variables in your deployment (DO NOT commit keys):
  - `SUPABASE_URL` — your project URL
  - `SUPABASE_KEY` — a service role key or anon key (service role required for server-side inserts if RLS is enabled)

Local example (macOS / Linux):

```bash
export SUPABASE_URL="https://your-project-ref.supabase.co"
export SUPABASE_KEY="your_service_role_or_anon_key"
npm install
npm run dev
```

Security note: you pasted keys into the chat. Treat those as compromised — rotate them in the Supabase dashboard and set new keys via environment variables instead of embedding them in code or chat.
