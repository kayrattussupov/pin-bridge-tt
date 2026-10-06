import Fastify, { FastifyInstance } from 'fastify';
import sharp from 'sharp';

/** Serves generated photos and broken responses for image pipeline tests. */
export interface ImageServer {
  url: string;
  app: FastifyInstance;
  hits: Map<string, number>;
  close(): Promise<void>;
}

export async function jpeg(width: number, height: number, color = '#3366aa'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

export async function startImageServer(): Promise<ImageServer> {
  const app = Fastify({ logger: false });
  const hits = new Map<string, number>();
  app.addHook('onRequest', async (req) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
  });
  const big = await jpeg(3200, 2400);
  const small = await jpeg(640, 480, '#aa3366');
  const png = await sharp({
    create: { width: 1000, height: 1000, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer();

  app.get('/photo/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const color = `#${Buffer.from(name).toString('hex').padEnd(6, '0').slice(0, 6)}`;
    return reply.type('image/jpeg').send(await jpeg(2000, 1500, color));
  });
  app.get('/big.jpg', async (_req, reply) => reply.type('image/jpeg').send(big));
  app.get('/small.jpg', async (_req, reply) => reply.type('image/jpeg').send(small));
  app.get('/transparent.png', async (_req, reply) => reply.type('image/png').send(png));
  app.get('/vector.svg', async (_req, reply) =>
    reply
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
      ),
  );
  app.get('/text.jpg', async (_req, reply) =>
    reply.type('image/jpeg').send('<html>not an image</html>'),
  );
  app.get('/missing.jpg', async (_req, reply) => reply.code(404).send('nope'));
  app.get('/broken.jpg', async (_req, reply) => reply.code(503).send('later'));
  app.get('/huge.bin', async (_req, reply) =>
    reply.type('image/jpeg').send(Buffer.alloc(2 * 1024 * 1024, 1)),
  );
  app.get('/slow.jpg', async (_req, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return reply.type('image/jpeg').send(small);
  });
  app.get('/redirect/:n', async (req, reply) => {
    const n = Number((req.params as { n: string }).n);
    return reply.redirect(n > 0 ? `/redirect/${n - 1}` : '/small.jpg');
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url, app, hits, close: () => app.close() };
}
