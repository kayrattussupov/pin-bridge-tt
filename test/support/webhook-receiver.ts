import Fastify, { FastifyInstance } from 'fastify';

export interface ReceivedWebhook {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: { id: string; type: string; created_at: string; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Captures webhook deliveries; `respond(path, [500, 200])` scripts status codes per path. */
export interface WebhookReceiver {
  url: string;
  app: FastifyInstance;
  received: ReceivedWebhook[];
  respond(path: string, statuses: number[]): void;
  of(path: string, type?: string): ReceivedWebhook[];
  waitFor(
    path: string,
    predicate: (w: ReceivedWebhook) => boolean,
    timeoutMs?: number,
  ): Promise<ReceivedWebhook>;
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const app = Fastify({ logger: false });
  const received: ReceivedWebhook[] = [];
  const scripts = new Map<string, number[]>();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/*', async (req, reply) => {
    const raw = req.body as string;
    received.push({ path: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
    const script = scripts.get(req.url);
    const status = script && script.length > 1 ? script.shift()! : (script?.[0] ?? 200);
    return reply.code(status).send({ ok: status < 300 });
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const of = (path: string, type?: string) =>
    received.filter((w) => w.path === path && (!type || w.body.type === type));
  return {
    url,
    app,
    received,
    respond: (path, statuses) => scripts.set(path, [...statuses]),
    of,
    async waitFor(path, predicate, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = of(path).find(predicate);
        if (hit) {
          return hit;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `no webhook at ${path} matched: got ${JSON.stringify(of(path).map((w) => w.body.type))}`,
      );
    },
    close: () => app.close(),
  };
}
