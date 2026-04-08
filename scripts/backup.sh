#!/bin/sh
# =============================================================================
# Gym Retention — Daily Database Backup
# Dumps PostgreSQL → gzips → uploads to S3 (or GCS via HMAC) → prunes old local files
#
# Required env vars:
#   PGPASSWORD              — DB password
#   AWS_ACCESS_KEY_ID       — AWS or GCS HMAC access key
#   AWS_SECRET_ACCESS_KEY   — AWS or GCS HMAC secret
#   AWS_DEFAULT_REGION      — e.g. ap-south-1
#   BACKUP_S3_BUCKET        — e.g. my-gym-backups
#   BACKUP_S3_PREFIX        — e.g. gym-retention/backups (optional, has default)
# =============================================================================

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="backup_${TIMESTAMP}.sql.gz"
LOCAL_PATH="/backups/${FILENAME}"
PREFIX="${BACKUP_S3_PREFIX:-gym-retention/backups}"
S3_KEY="${PREFIX}/${FILENAME}"

echo "[backup] Starting backup at $(date)"

# 1. Dump and compress
pg_dump -h postgres -U gym_user gym_retention | gzip > "${LOCAL_PATH}"
echo "[backup] Dump created: ${LOCAL_PATH}"

# 2. Upload to S3 / GCS (via AWS-compatible API)
if [ -n "${BACKUP_S3_BUCKET}" ] && [ -n "${AWS_ACCESS_KEY_ID}" ]; then
  aws s3 cp "${LOCAL_PATH}" "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" \
    --storage-class STANDARD_IA \
    --no-progress
  echo "[backup] Uploaded to s3://${BACKUP_S3_BUCKET}/${S3_KEY}"

  # Remove S3 objects older than 90 days
  CUTOFF_DATE=$(date -d '90 days ago' +%Y%m%d 2>/dev/null || date -v-90d +%Y%m%d)
  aws s3 ls "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" | awk '{print $4}' | \
  while read -r key; do
    KEY_DATE=$(echo "$key" | grep -oE '[0-9]{8}' | head -1)
    if [ -n "$KEY_DATE" ] && [ "$KEY_DATE" -lt "$CUTOFF_DATE" ]; then
      aws s3 rm "s3://${BACKUP_S3_BUCKET}/${PREFIX}/${key}"
      echo "[backup] Removed old S3 backup: ${key}"
    fi
  done
else
  echo "[backup] WARNING: BACKUP_S3_BUCKET or AWS credentials not set — backup stored locally only"
fi

# 3. Prune local backups older than 30 days
find /backups -name "backup_*.sql.gz" -mtime +30 -delete
echo "[backup] Pruned local backups older than 30 days"

echo "[backup] Completed at $(date)"
