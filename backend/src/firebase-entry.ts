import { onRequest } from 'firebase-functions/v2/https';
import app from './server';

// Wrap the Express app as a Firebase HTTP Function.
// app.listen() is skipped automatically via the K_SERVICE env var check in server.ts.
export const api = onRequest(
  {
    region: 'asia-south1', // Mumbai — closest region for India
    memory: '512MiB',
    timeoutSeconds: 60,
    concurrency: 80,
    secrets: [
      'DATABASE_URL',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'ADMIN_SECRET',
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'SMTP_FROM',
      'SMTP_SECURE',
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'CORS_ORIGIN',
    ],
  },
  app,
);
