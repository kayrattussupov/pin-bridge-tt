#!/usr/bin/env bash
# Daily PostgreSQL backup for Pin Bridge. Run from the repository root on the server, e.g. cron:
#   17 3 * * * cd /opt/pin-bridge && ./scripts/backup.sh >> /var/log/pin-bridge-backup.log 2>&1
#
# Writes backups/pinbridge-<UTC timestamp>.dump (pg_dump custom format), keeps BACKUP_KEEP_DAYS days.
# Redis is not backed up: queues are rebuilt from the database (the worker re-queues lost jobs).
#
# IMPORTANT: Pin tokens and secrets in the dump are encrypted with ENCRYPTION_KEY. Keep a copy of
# .env (ENCRYPTION_KEY, API_KEY_PEPPER) somewhere safe and separate; a dump without it cannot
# restore working connections.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# Override for testing or a non-compose setup, e.g. BACKUP_PGDUMP="pg_dump -h db.internal".
BACKUP_PGDUMP="${BACKUP_PGDUMP:-docker compose exec -T postgres pg_dump}"

if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/pinbridge-$stamp.dump"
tmp="$target.partial"

# shellcheck disable=SC2086
$BACKUP_PGDUMP -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner > "$tmp"
# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$tmp" > /dev/null 2>&1 || docker compose exec -T postgres pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$target"
chmod 600 "$target"
echo "$(date -u +%FT%TZ) backup ok: $target ($(du -h "$target" | cut -f1))"

find "$BACKUP_DIR" -name 'pinbridge-*.dump' -type f -mtime "+$BACKUP_KEEP_DAYS" -print -delete

# Off-site copy (recommended): uncomment and configure, e.g. rclone to S3/Backblaze.
# rclone copy "$target" remote:pin-bridge-backups/
