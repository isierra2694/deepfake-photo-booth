# Deepfake booth — Vercel Blob upload function

A one-file Vercel serverless function that issues short-lived, scoped
**client-upload tokens** so the booth (a local static page) can upload finished
MP4 clips straight to Vercel Blob. Your `BLOB_READ_WRITE_TOKEN` stays on Vercel
and never ships to the kiosk.

## What it does

`POST /api/upload` runs `handleUpload()` from `@vercel/blob/client`:

- restricts uploads to `video/mp4`
- stores at `videos/<uuid>.mp4` with `addRandomSuffix: false`, so the public URL
  is deterministic: `https://<store>.public.blob.vercel-storage.com/videos/<uuid>.mp4`
- returns a token valid for ~10 minutes
- sends CORS headers so the booth can call it from `localhost`

## Deploy

1. Install the CLI and sign in: `npm i -g vercel && vercel login`
2. From this folder: `vercel` (first run links/creates a project), then
   `vercel --prod` to deploy.
3. Create a Blob store and connect it to this project:
   - Dashboard → your project → **Storage** → **Create** → **Blob** → access **Public**
   - This auto-adds `BLOB_READ_WRITE_TOKEN` to the project's env vars.
   - (Or CLI: `vercel blob create-store booth --access public --yes`)
4. Redeploy so the function picks up the token: `vercel --prod`

Your function URL will be something like
`https://<your-project>.vercel.app/api/upload`.

## Configure the booth

In `index.html`, set:

```js
const UPLOAD_ENDPOINT   = 'https://<your-project>.vercel.app/api/upload';
const LANDING_PAGE_BASE = 'https://<your-lovable-page>';
```

## Allow your booth's origin (CORS)

Edit `ALLOWED_ORIGINS` in `api/upload.js` to match the host:port that serves the
booth. The default `npm start` serves it at `http://localhost:3000` and
`http://127.0.0.1:3000`, which are already listed.

## Getting the video on the Lovable page (steps 3 & 4)

The QR encodes `https://<your-lovable-page>?v=<uuid>`. On the landing page:

1. Read `v` from the query string.
2. Collect the visitor's email (your gate) and store it however you like.
3. Build the download URL — either:
   - reconstruct it: `https://<store>.public.blob.vercel-storage.com/videos/<v>.mp4`
     (grab the `<store>` host once from the first upload's logged URL), or
   - have the booth encode the full URL instead (see `LANDING_PAGE_BASE` usage).
4. Trigger the download with an `<a download>` click or `fetch()` → object URL.

> Public blobs are reachable by anyone who has the exact URL, so the email step
> is a *soft* gate. For a hard gate, use a **private** Blob store + signed URLs
> and have the Lovable page's backend mint the signed URL only after email capture.
