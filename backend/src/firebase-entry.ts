import { onRequest } from 'firebase-functions/v2/https';
import app from './server';

// Wrap the Express app as a Firebase HTTP Function.
// Firebase handles the HTTP server — app.listen() is skipped via K_SERVICE env var.
export const api = onRequest(
  {
    region: 'asia-south1', // Mumbai — closest region for India
    memory: '512MiB',
    timeoutSeconds: 60,
    concurrency: 80,
  },
  app,
);
