import { handleUpload } from '@vercel/blob/client';

// Origins allowed to request upload tokens from this function.
// Add whatever host:port your booth (index.html) is served from.
// Use ['*'] only for quick local testing — prefer an explicit list in production.
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function resolveAllowedOrigin(request) {
  const origin = request.headers.origin || '';
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function applyCors(request, response) {
  response.setHeader('Access-Control-Allow-Origin', resolveAllowedOrigin(request));
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(request, response) {
  applyCors(request, response);

  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const jsonResponse = await handleUpload({
      body: request.body,
      request,
      onBeforeGenerateToken: async (/* pathname, clientPayload */) => ({
        // iPhone-playable clips only. (access: 'public' is set client-side in upload()).
        allowedContentTypes: ['video/mp4'],
        // Deterministic public URL: <store>.public.blob.vercel-storage.com/videos/<uuid>.mp4
        // so the Lovable page can rebuild the URL from just the id.
        addRandomSuffix: false,
        // Cap uploads (~200 MB) as a guardrail. Tune to your clip length.
        maximumSizeInBytes: 200 * 1024 * 1024,
        validUntil: Math.floor(Date.now() / 1000) + 600, // token valid 10 min
      }),
      onUploadCompleted: async ({ blob }) => {
        // Fired by a Vercel Blob webhook once the upload finishes.
        // Optional: persist blob.url + the video id to a DB here.
        console.log('blob upload completed:', blob.url);
      },
    });

    return response.status(200).json(jsonResponse);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
}
