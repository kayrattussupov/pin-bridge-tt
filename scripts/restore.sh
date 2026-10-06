#!/usr/bin/env bash
# Restores a backup made by backup.sh into the compose PostgreSQL. DESTROYS current data.
#   ./scripts/restore.sh backups/pinbridge-20261005T031700Z.dump
# Stop api and worker first: docker compose stop api worker
set -euo pipefail

dump="${1:?usage: restore.sh <dump file>}"
BACKUP_PGRESTORE="${BACKUP_PGRESTORE:-docker compose exec -T postgres pg_restore}"

if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

read -r -p "Replace ALL data in database '$POSTGRES_DB' with $dump? Type 'restore' to continue: " answer
[[ "$answer" == "restore" ]] || { echo "aborted"; exit 1; }

# shellcheck disable=SC2086
$BACKUP_PGRESTORE -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction < "$dump"
echo "restored $dump. Start the app again: docker compose up -d api worker"
