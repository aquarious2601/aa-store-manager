#!/usr/bin/env bash
# Daily backup of the AA Shop Manager MySQL database.
#
# Runs as root from cron at 03:30 each night. Keeps 14 days of compressed
# dumps under /var/backups/aashop/. To off-site backups, uncomment the
# `aws s3 cp` line at the bottom and set AWS_BUCKET in /etc/aashop-backup.env.

set -euo pipefail

BACKUP_DIR=/var/backups/aashop
RETENTION_DAYS=14
DB=aashop

mkdir -p "$BACKUP_DIR"

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/${DB}-${ts}.sql.gz"

# mysqldump runs as the unix `root` user via auth_socket on Ubuntu MySQL 8;
# no password needed. --single-transaction gives us a consistent snapshot
# without locking the whole DB during the dump.
mysqldump --single-transaction --quick --routines --triggers "$DB" | gzip -c > "$out"

# Prune anything older than RETENTION_DAYS days
find "$BACKUP_DIR" -name "${DB}-*.sql.gz" -mtime +"$RETENTION_DAYS" -delete

# --- Optional S3 off-site copy ----------------------------------------------
# Install awscli (`apt install awscli`) and configure with a dedicated IAM
# user that only has s3:PutObject on the target bucket.
#
# if [ -f /etc/aashop-backup.env ]; then
#     . /etc/aashop-backup.env
#     aws s3 cp "$out" "s3://$AWS_BUCKET/$(basename "$out")"
# fi

echo "backup: wrote $out ($(stat -c %s "$out") bytes)"
