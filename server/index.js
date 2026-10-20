// Local "share" backend for the deepfake photo booth kiosk.
//
// Holds the secrets (Vercel Blob token + email Lambda token) that must never
// live in the browser. Exposes a single endpoint, POST /api/share, which the
// kiosk page calls when an attendee submits their email:
//   1. Validate that both an email and a video were provided.
//   2. Upload the recorded video to Vercel Blob at a fixed, unguessable path.
//   3. Invoke the email Lambda with a share link (video id in query).
//
// Runs locally alongside the deep-live-cam server (:8000) and live-server (:3000).

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { put } = require('@vercel/blob');

const {
  PORT = '8787',
  ALLOWED_ORIGIN = 'http://localhost:3000',
  BLOB_READ_WRITE_TOKEN,
  EMAIL_LAMBDA_URL = 'https://o6prusgwzk2k7axom67ihzhrgm0hyuge.lambda-url.us-east-1.on.aws/',
  EMAIL_LAMBDA_TOKEN,
} = process.env;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB ceiling so a huge file can't hang the box
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const UPLOAD_LOG = path.join(LOG_DIR, 'video-uploads.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

async function logUpload({ id, email = '', status, error = '' }) {
  const entry = {
    timestamp: new Date().toISOString(),
    id,
    email,
    status,
    ...(error ? { error } : {}),
  };
  try {
    await fs.promises.appendFile(UPLOAD_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (logError) {
    console.error('[share] Failed to write upload log:', logError.message);
  }
}

// ---- Startup config check (warn only, so the server still boots on placeholders) ----
const REQUIRED_ENV = [
  'BLOB_READ_WRITE_TOKEN',
  'EMAIL_LAMBDA_TOKEN',
];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length) {
  console.warn(
    `[share] WARNING: missing env vars: ${missingEnv.join(', ')}. ` +
      'Requests will fail until these are set in .env (see .env.example).'
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, configured: missingEnv.length === 0 });
});

// Use the placeholder landing page until the real share page is ready.
function buildShareLink(videoId) {
  const link = new URL('https://socure-deepfake-photo-booth.lovable.app/');
  link.searchParams.set('video', videoId);
  return link.toString();
}

async function sendShareEmail(toEmail, link) {
  if (!EMAIL_LAMBDA_TOKEN) {
    throw new Error('EMAIL_LAMBDA_TOKEN is not configured.');
  }

  const response = await fetch(EMAIL_LAMBDA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMAIL_LAMBDA_TOKEN}`,
    },
    body: JSON.stringify({ email: toEmail, link }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`Email Lambda returned HTTP ${response.status}.`);
  }
}

app.post('/api/share', (req, _res, next) => {
  req.uploadId = crypto.randomUUID();
  next();
}, upload.single('video'), async (req, res) => {
  const email = (req.body?.email || '').trim();

  // Validation: no email or no video means no upload (defense-in-depth; the
  // frontend also gates this).
  if (!EMAIL_RE.test(email)) {
    await logUpload({ id: req.uploadId, email, status: 'validation_failed', error: 'A valid email is required.' });
    return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    await logUpload({ id: req.uploadId, email, status: 'validation_failed', error: 'A video file is required.' });
    return res.status(400).json({ ok: false, error: 'A video file is required.' });
  }

  const videoId = req.uploadId;

  // 1) Upload to Vercel Blob at a fixed, unguessable path so the Lovable page
  //    can reconstruct the URL from just the id.
  try {
    await put(`videos/${videoId}.mp4`, req.file.buffer, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'video/mp4',
      token: BLOB_READ_WRITE_TOKEN,
    });
  } catch (err) {
    console.error('[share] Blob upload failed:', err);
    await logUpload({ id: videoId, email, status: 'blob_upload_failed', error: err.message });
    return res.status(502).json({ ok: false, error: 'Upload failed. Please try again.' });
  }

  await logUpload({ id: videoId, email, status: 'video_uploaded' });

  const link = buildShareLink(videoId);

  // 2) Email the attendee. Per configuration, an email failure is a soft
  //    success: the video is stored, so we log enough to resend manually.
  try {
    await sendShareEmail(email, link);
    await logUpload({ id: videoId, email, status: 'email_sent' });
  } catch (err) {
    await logUpload({ id: videoId, email, status: 'email_failed', error: err.message });
    console.error(
      `[share] Email send FAILED but video is stored. ` +
        `Resend manually -> email=${email} videoId=${videoId} link=${link}`,
      err
    );
  }

  return res.json({ ok: true, videoId });
});

// Multer / payload errors (e.g. file too large) land here.
app.use(async (err, req, res, _next) => {
  const email = (req.body?.email || '').trim();
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    await logUpload({
      id: req.uploadId || crypto.randomUUID(),
      email,
      status: 'request_failed',
      error: err.message,
    });
    return res
      .status(tooBig ? 413 : 400)
      .json({ ok: false, error: tooBig ? 'Video is too large.' : 'Upload error.' });
  }
  await logUpload({
    id: req.uploadId || crypto.randomUUID(),
    email,
    status: 'request_failed',
    error: err.message,
  });
  console.error('[share] Unexpected error:', err);
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
});

app.listen(Number(PORT), () => {
  console.log(`[share] Listening on http://127.0.0.1:${PORT} (allowed origin: ${ALLOWED_ORIGIN})`);
});
