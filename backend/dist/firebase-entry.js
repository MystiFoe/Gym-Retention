"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = void 0;
const https_1 = require("firebase-functions/v2/https");
const server_1 = __importDefault(require("./server"));
// Wrap the Express app as a Firebase HTTP Function.
// app.listen() is skipped automatically via the K_SERVICE env var check in server.ts.
exports.api = (0, https_1.onRequest)({
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
}, server_1.default);
//# sourceMappingURL=firebase-entry.js.map