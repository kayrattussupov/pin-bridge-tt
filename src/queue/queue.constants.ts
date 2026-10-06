export const QUEUES = {
  system: 'system',
  dictionaries: 'dictionaries',
  listings: 'listings',
  status: 'status',
  webhooks: 'webhooks',
} as const;

export const LISTING_JOBS = {
  sync: 'sync',
} as const;

export const DICTIONARY_JOBS = {
  sync: 'sync',
} as const;

/** Daily at 04:17 UTC (00:17 in Trinidad), off the top of the hour. */
export const DICTIONARY_SYNC_CRON = '17 4 * * *';
/** Data older than this triggers a sync when a worker starts. */
export const DICTIONARY_SYNC_INTERVAL_MS = 24 * 3600 * 1000;

export const SYSTEM_JOBS = {
  heartbeat: 'heartbeat',
  reconcile: 'reconcile',
} as const;

export const WORKER_HEARTBEAT_KEY = 'pin-bridge:worker:heartbeat';
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
