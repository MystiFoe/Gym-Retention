/**
 * Auth API Tests — POST /api/auth/login, POST /api/auth/refresh, GET /api/health
 *
 * Strategy: a single shared `mockQuery` is used for ALL pg queries (both pool.query
 * and client.query via pool.connect()). Tests use mockResolvedValueOnce to queue
 * responses in the order the endpoint makes DB calls.
 */
export {};
//# sourceMappingURL=auth.test.d.ts.map