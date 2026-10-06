import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Process-wide metrics. Counters and histograms live at module level so any code can record
 * without injection; scrape-time gauges (queues, database state) are added per app by
 * MetricsCollector.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'pinbridge_' });

export const metrics = {
  httpDuration: new Histogram({
    name: 'pinbridge_http_request_duration_seconds',
    help: 'Agency API request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  pinRequests: new Counter({
    name: 'pinbridge_pin_requests_total',
    help: 'Calls to pin.tt by endpoint and outcome (ok or PinError kind)',
    labelNames: ['endpoint', 'outcome'] as const,
    registers: [registry],
  }),
  pinDuration: new Histogram({
    name: 'pinbridge_pin_request_duration_seconds',
    help: 'pin.tt call latency (calls that were sent)',
    labelNames: ['endpoint'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  }),
  listingSync: new Counter({
    name: 'pinbridge_listing_sync_total',
    help: 'Listing sync job outcomes (synced, failed, retry, superseded, skipped)',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  imageFetch: new Counter({
    name: 'pinbridge_image_fetch_total',
    help: 'Agency photo downloads by outcome (ok or error code)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  webhookDeliveries: new Counter({
    name: 'pinbridge_webhook_deliveries_total',
    help: 'Webhook delivery attempts (delivered, failed, dead)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  enrollments: new Counter({
    name: 'pinbridge_enrollments_total',
    help: 'Enrollment outcomes (created, retried, invalid_invite, agency_exists, rate_limited)',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  dictionarySync: new Counter({
    name: 'pinbridge_dictionary_sync_total',
    help: 'Pin dictionary refreshes per dictionary and status',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
};
