#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./restore.sh <backup_file>"
  exit 1
fi

BACKUP_FILE=$1

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "Restoring from: $BACKUP_FILE"
gunzip < $BACKUP_FILE | docker-compose exec -T postgres psql -U gym_user -d gym_retention

echo "✅ Restore completed"

