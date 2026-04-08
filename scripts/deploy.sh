#!/bin/bash
set -e

echo "🚀 Starting Gym Retention Deployment..."

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ .env file not found!"
  echo "Please copy .env.example to .env and configure it:"
  echo "  cp .env.example .env"
  exit 1
fi

# Load environment variables
export $(cat .env | grep -v '#' | xargs)

# Create backups directory
mkdir -p backups

# Stop existing containers
echo "Stopping existing containers..."
docker-compose down || true

# Build images
echo "Building Docker images..."
docker-compose build

# Start services
echo "Starting services..."
docker-compose up -d

# Wait for database
echo "Waiting for database to be ready..."
sleep 10

# Run migrations
echo "Running database migrations..."
docker-compose exec -T postgres psql -U gym_user -d gym_retention -f /docker-entrypoint-initdb.d/01-schema.sql || true

# Check health
echo ""
echo "Waiting for API to be healthy..."
sleep 5

HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)

if [ "$HEALTH_CHECK" = "200" ]; then
  echo "✅ Deployment successful!"
  echo ""
  echo "Services running:"
  echo "  API: http://localhost:3000"
  echo "  Nginx: http://localhost:80"
  echo "  Prometheus: http://localhost:9090"
  echo "  Grafana: http://localhost:3001 (admin/admin)"
  echo ""
  echo "View logs: docker-compose logs -f api"
else
  echo "⚠️ Health check failed. Checking logs..."
  docker-compose logs api
  exit 1
fi

