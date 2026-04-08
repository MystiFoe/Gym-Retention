# Multi-stage build for production
FROM node:18-alpine AS builder

WORKDIR /build

# Copy package files
COPY backend/package*.json ./
COPY backend/tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY backend/src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Install utilities
RUN apk add --no-cache dumb-init curl postgresql-client

# Copy package files
COPY backend/package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder
COPY --from=builder /build/dist ./dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/server.js"]

