/**
 * In-memory imitation of the pin.tt API, built from what Pin's developer described in the ClickUp
 * task (there is no staging stand). Used by contract tests and for running the bridge locally.
 *
 * Mirrors: Device-Api-Key on every endpoint but device_api_key, TT-only phone_verify with a
 * 5-per-10-minutes SMS limit and `end_date`, token=1 switch, stable tokens per phone, one-by-one
 * picture upload with 400 on non-images, silent truncation to 16 images, post-moderation
 * (status 0 right away), not_paid in rubrics 20/21, the Cloudflare 403 page for blocked IPs.
 */
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const PREFIX = '/api/v1.6';
const SMS_WINDOW_MS = 10 * 60 * 1000;
const SMS_LIMIT = 5;
const MAX_IMAGES = 16;
const PAGE_SIZE = 20;

export interface FakePinOptions {
  smsCode?: string;
  /** Free listings per user per 30 days in rubric 20 (Residential sale) before not_paid. */
  freeSaleListings?: number;
  /** Free listings per user per 30 days in rubric 21 (Residential rent) priced above 4000. */
  freeRentListings?: number;
  /** Seconds to wait before another SMS, as reported in `end_date`. */
  smsCooldownSeconds?: number;
}

export interface Fault {
  /** `METHOD /route` without the /api/v1.6 prefix, e.g. `POST /items/` or `GET /items/front_my/`. */
  route: string;
  /** Respond with this status instead of handling the request. */
  status?: number;
  body?: unknown;
  /** Serve the Cloudflare block page (HTML 403). */
  cloudflare?: boolean;
  /**
   * Slow response. With `status`/`cloudflare`: wait, then answer that. Without: the request is
   * handled normally (side effects applied) and only the response is delayed, like a slow Pin.
   */
  delayMs?: number;
  times?: number;
}

export interface FakeItem {
  id: number;
  ownerPhone: string;
  rubric: number;
  city: number;
  currency_id: number;
  title: string;
  description: string;
  price?: number;
  images: number[];
  coordinates?: { latitude: number; longitude: number };
  attrs: Record<string, unknown>;
  external_id: string;
  item_link?: string;
  user: { name: string; email?: string };
  status: number;
  not_paid: boolean;
  moderator_comment: string | null;
  created_at: number;
}

interface User {
  id: number;
  phone: string;
  token: string;
  name?: string;
}

export const RUBRIC_FORMS: Record<number, unknown> = {
  21: {
    rubric: 21,
    name: 'Residential rent',
    fields: [
      {
        slug: 'type',
        title: 'Type',
        required: true,
        multiple: false,
        variants: [
          { key: 1, value: 'House' },
          { key: 2, value: 'Apartment' },
          { key: 3, value: 'Townhouse' },
        ],
      },
      {
        slug: 'bedrooms',
        title: 'Bedrooms',
        required: true,
        multiple: false,
        variants: [
          { key: 1, value: '1' },
          { key: 2, value: '2' },
          { key: 10, value: '3' },
          { key: 11, value: '4+' },
        ],
      },
      {
        slug: 'number-of-bathrooms',
        title: 'Bathrooms',
        required: false,
        multiple: false,
        variants: [
          { key: 20, value: '1' },
          { key: 30, value: '2' },
          { key: 40, value: '3+' },
        ],
      },
      {
        slug: 'water',
        title: 'Water',
        required: false,
        multiple: true,
        variants: [
          { key: 10, value: 'WASA' },
          { key: 20, value: 'Tank' },
        ],
      },
      { slug: 'floor-area', title: 'Floor area, sq.ft', required: false, numeric: true },
    ],
  },
  20: {
    rubric: 20,
    name: 'Residential sale',
    fields: [
      {
        slug: 'type',
        title: 'Type',
        required: true,
        multiple: false,
        variants: [
          { key: 1, value: 'House' },
          { key: 2, value: 'Apartment' },
        ],
      },
      {
        slug: 'bedrooms',
        title: 'Bedrooms',
        required: true,
        multiple: false,
        variants: [
          { key: 1, value: '1' },
          { key: 2, value: '2' },
          { key: 10, value: '3' },
        ],
      },
    ],
  },
};

export const REGIONS = [
  { id: 17, name: 'Central' },
  { id: 18, name: 'North East' },
  { id: 21, name: 'North West' },
  { id: 23, name: 'South West' },
  { id: 22, name: 'South East' },
  { id: 15, name: 'Tobago' },
];

const RUBRIC_TREE = [
  {
    id: 2,
    name: 'Real estate',
    children: [
      { id: 20, name: 'Residential sale', children: [] },
      { id: 21, name: 'Residential rent', children: [] },
    ],
  },
];

const CLOUDFLARE_PAGE =
  '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>' +
  '<body><h1>Sorry, you have been blocked</h1></body></html>';

function digits(phone: string): string {
  return phone.replace(/\D/g, '');
}

function isImage(buffer: Buffer): boolean {
  const jpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png =
    buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return jpeg || png;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakePinState {
  readonly deviceKeys = new Set<string>();
  readonly smsRequests = new Map<string, number[]>();
  readonly pendingCodes = new Map<string, number>();
  readonly users = new Map<string, User>();
  readonly pics = new Map<number, { size: number }>();
  readonly items = new Map<number, FakeItem>();
  readonly calls: { route: string; deviceKey?: string; authorization?: string }[] = [];
  cloudflareAll = false;
  nextId = 1000;
}

export interface FakePinControl {
  readonly state: FakePinState;
  failNext(fault: Fault): void;
  cloudflareBlockAll(enabled: boolean): void;
  /** Forced logout: the old token stops working, the next phone_verify issues a new one. */
  revokeToken(phone: string): void;
  setModeration(itemId: number, status: number, comment?: string | null): void;
  smsCode(): string;
  callCount(route: string): number;
  reset(): void;
}

export interface FakePin {
  app: FastifyInstance;
  url: string;
  control: FakePinControl;
  close(): Promise<void>;
}

export function buildFakePin(options: FakePinOptions = {}): {
  app: FastifyInstance;
  control: FakePinControl;
} {
  const smsCode = options.smsCode ?? '1234';
  const freeSale = options.freeSaleListings ?? 5;
  const freeRent = options.freeRentListings ?? 4;
  const cooldown = options.smsCooldownSeconds ?? 60;
  let state = new FakePinState();
  const faults: (Fault & { times: number })[] = [];

  const delayedResponses = new WeakMap<FastifyRequest, number>();

  const app = Fastify({ logger: false });
  app.addHook('onSend', async (req, _reply, payload) => {
    const delay = delayedResponses.get(req);
    if (delay) {
      await sleep(delay);
    }
    return payload;
  });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const routeKey = (req: FastifyRequest) =>
    `${req.method} ${(req.routeOptions.url ?? req.url).replace(PREFIX, '')}`;

  const cloudflare = (reply: FastifyReply) =>
    reply
      .code(403)
      .header('server', 'cloudflare')
      .header('cf-ray', '8a1b2c3d4e5f-AMS')
      .type('text/html; charset=UTF-8')
      .send(CLOUDFLARE_PAGE);

  app.addHook('onRequest', async (req, reply) => {
    const route = routeKey(req);
    state.calls.push({
      route,
      deviceKey: req.headers['device-api-key'] as string | undefined,
      authorization: req.headers.authorization,
    });
    if (state.cloudflareAll) {
      return cloudflare(reply);
    }
    const index = faults.findIndex((f) => f.route === route);
    if (index >= 0) {
      const fault = faults[index]!;
      fault.times -= 1;
      if (fault.times <= 0) {
        faults.splice(index, 1);
      }
      if (fault.delayMs && !fault.status && !fault.cloudflare) {
        delayedResponses.set(req, fault.delayMs);
      } else if (fault.delayMs) {
        await sleep(fault.delayMs);
      }
      if (fault.cloudflare) {
        return cloudflare(reply);
      }
      if (fault.status) {
        return reply.code(fault.status).send(fault.body ?? { detail: `injected ${fault.status}` });
      }
    }
    if (route !== 'POST /items/device_api_key/') {
      const key = req.headers['device-api-key'];
      if (typeof key !== 'string' || !state.deviceKeys.has(key)) {
        return reply.code(403).send({
          detail: 'Authentication credentials were not provided. Device-Api-Key required.',
        });
      }
    }
  });

  const userOf = (req: FastifyRequest): User | undefined => {
    const match = /^Token (.+)$/.exec(req.headers.authorization ?? '');
    if (!match) {
      return undefined;
    }
    return [...state.users.values()].find((u) => u.token === match[1]);
  };

  const requireUser = (req: FastifyRequest, reply: FastifyReply): User | undefined => {
    const user = userOf(req);
    if (!user) {
      void reply.code(401).send({ detail: 'Invalid token.' });
    }
    return user;
  };

  const serialize = (item: FakeItem) => {
    const { ownerPhone: _owner, created_at: _created, ...rest } = item;
    return {
      ...rest,
      images: item.images.map((id) => ({
        id,
        url: `https://img.pin.tt/800/${id}.jpg`,
        orig: `https://img.pin.tt/1600/${id}.webp`,
      })),
    };
  };

  type ItemBody = Partial<Omit<FakeItem, 'coordinates'>> & {
    coordinates?: unknown;
    images?: unknown;
  };

  const validate = (body: ItemBody, partial: boolean): Record<string, string[]> => {
    const errors: Record<string, string[]> = {};
    const need = (field: keyof ItemBody, ok: boolean) => {
      if (!ok && (!partial || body[field] !== undefined)) {
        errors[field] = ['This field is required.'];
      }
    };
    need('rubric', typeof body.rubric === 'number');
    need('city', typeof body.city === 'number');
    need('currency_id', typeof body.currency_id === 'number');
    need('title', typeof body.title === 'string' && body.title.length > 0);
    if (!partial || body.user !== undefined) {
      if (!body.user || typeof body.user.name !== 'string' || body.user.name.length === 0) {
        errors.user = ['name: This field is required.'];
      }
    }
    if (body.coordinates !== undefined) {
      const c = body.coordinates as Record<string, unknown> | unknown[];
      if (Array.isArray(c) || typeof c !== 'object' || c === null) {
        errors.coordinates = ['Expected an object with latitude and longitude.'];
      }
    }
    if (body.images !== undefined) {
      const images = Array.isArray(body.images) ? body.images : [];
      const unknown = images.filter((id) => !state.pics.has(Number(id)));
      if (!Array.isArray(body.images) || unknown.length > 0) {
        errors.images = [`Unknown image ids: ${unknown.join(', ')}`];
      }
    }
    const rubric = body.rubric;
    if (typeof rubric === 'number') {
      const form = RUBRIC_FORMS[rubric] as
        { fields: { slug: string; required: boolean }[] } | undefined;
      if (!form) {
        errors.rubric = ['Unknown rubric.'];
      } else if (!partial || body.attrs !== undefined) {
        // Prod (2026-10-07): keys inside attrs carry the prefix, `{attrs: {attrs__type: 1}}`;
        // bare slugs are ignored and reported as empty.
        for (const field of form.fields.filter((f) => f.required)) {
          if (body.attrs?.[`attrs__${field.slug}`] === undefined) {
            errors[`attrs__${field.slug}`] = [`${field.slug} can not be empty`];
          }
        }
      }
    }
    return errors;
  };

  const notPaid = (user: User, rubric: number, price: number | undefined): boolean => {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const mine = [...state.items.values()].filter(
      (i) => i.ownerPhone === user.phone && i.rubric === rubric && i.created_at >= since,
    );
    if (rubric === 20) {
      return mine.length >= freeSale;
    }
    if (rubric === 21 && (price ?? 0) > 4000) {
      return mine.filter((i) => (i.price ?? 0) > 4000).length >= freeRent;
    }
    return false;
  };

  const ownedItem = (req: FastifyRequest, reply: FastifyReply): FakeItem | undefined => {
    const user = requireUser(req, reply);
    if (!user) {
      return undefined;
    }
    const item = state.items.get(Number((req.params as { id: string }).id));
    if (!item) {
      void reply.code(404).send({ detail: 'Not found.' });
      return undefined;
    }
    if (item.ownerPhone !== user.phone) {
      void reply.code(403).send({ detail: 'You do not have permission to perform this action.' });
      return undefined;
    }
    return item;
  };

  app.register(
    async (api) => {
      api.post('/items/device_api_key/', async () => {
        const uuid = randomUUID();
        state.deviceKeys.add(uuid);
        return { id: uuid, user: null, push_token: null, maestro_uuid: null };
      });

      api.get('/users/phone_verify/', async (req) => {
        const { phone = '' } = req.query as { phone?: string; check_type?: string };
        const key = req.headers['device-api-key'] as string;
        const number = digits(phone);
        if (!number.startsWith('1868') || number.length !== 11) {
          return { status: 1, errors: ['Could not determine the country by number'], end_date: '' };
        }
        const now = Date.now();
        const recent = (state.smsRequests.get(key) ?? []).filter((t) => now - t < SMS_WINDOW_MS);
        if (recent.length >= SMS_LIMIT) {
          const wait = Math.ceil((recent[0]! + SMS_WINDOW_MS - now) / 1000);
          return { status: 1, errors: ['Too many requests. Try again later.'], end_date: wait };
        }
        recent.push(now);
        state.smsRequests.set(key, recent);
        state.pendingCodes.set(number, now);
        return { status: 0, end_date: cooldown };
      });

      api.post('/users/phone_verify/', async (req) => {
        const { token } = req.query as { token?: string };
        const body = (req.body ?? {}) as { phone?: string; code?: string; check_type?: string };
        const number = digits(body.phone ?? '');
        const requestedAt = state.pendingCodes.get(number);
        if (!requestedAt || Date.now() - requestedAt > SMS_WINDOW_MS || body.code !== smsCode) {
          return { status: 1, errors: ['Invalid code'] };
        }
        let user = state.users.get(number);
        if (!user) {
          user = { id: state.nextId++, phone: number, token: randomUUID().replace(/-/g, '') };
          state.users.set(number, user);
        }
        return token === '1' ? { status: 0, token: user.token } : { status: 0 };
      });

      api.post('/items/pics/', async (req, reply) => {
        if (!requireUser(req, reply)) {
          return reply;
        }
        const file = await req.file();
        if (!file || file.fieldname !== 'img') {
          return reply.code(400).send({ img: ['No file was submitted.'] });
        }
        const buffer = await file.toBuffer();
        if (!isImage(buffer)) {
          return reply.code(400).send({ img: ['Upload a valid image.'] });
        }
        const id = state.nextId++;
        state.pics.set(id, { size: buffer.length });
        return { id };
      });

      api.post('/items/validate_ad/', async (req, reply) => {
        if (!requireUser(req, reply)) {
          return reply;
        }
        const errors = validate(req.body as ItemBody, false);
        return Object.keys(errors).length ? reply.code(400).send(errors) : { status: 0 };
      });

      api.post('/items/', async (req, reply) => {
        const user = requireUser(req, reply);
        if (!user) {
          return reply;
        }
        const body = req.body as ItemBody;
        const errors = validate(body, false);
        const duplicate = [...state.items.values()].some(
          (i) =>
            i.ownerPhone === user.phone && body.external_id && i.external_id === body.external_id,
        );
        if (duplicate) {
          errors.external_id = ['Item with this external_id already exists.'];
        }
        if (Object.keys(errors).length) {
          return reply.code(400).send(errors);
        }
        user.name ??= body.user!.name;
        const item: FakeItem = {
          id: state.nextId++,
          ownerPhone: user.phone,
          rubric: body.rubric!,
          city: body.city!,
          currency_id: body.currency_id!,
          title: body.title!,
          description: body.description ?? '',
          price: body.price,
          images: ((body.images as unknown[]) ?? []).slice(0, MAX_IMAGES).map(Number),
          coordinates: body.coordinates as FakeItem['coordinates'],
          attrs: (body.attrs as Record<string, unknown>) ?? {},
          external_id: body.external_id ?? '',
          item_link: body.item_link,
          user: body.user!,
          status: 0,
          not_paid: notPaid(user, body.rubric!, body.price),
          moderator_comment: null,
          created_at: Date.now(),
        };
        state.items.set(item.id, item);
        return reply.code(201).send(serialize(item));
      });

      api.post('/items/:id/', async (req, reply) => {
        const item = ownedItem(req, reply);
        if (!item) {
          return reply;
        }
        const body = req.body as ItemBody;
        const errors = validate(body, false);
        if (Object.keys(errors).length) {
          return reply.code(400).send(errors);
        }
        Object.assign(item, body, {
          images: ((body.images as unknown[]) ?? []).slice(0, MAX_IMAGES).map(Number),
        });
        return serialize(item);
      });

      api.patch('/items/:id/partial_update/', async (req, reply) => {
        const item = ownedItem(req, reply);
        if (!item) {
          return reply;
        }
        const body = req.body as ItemBody;
        const errors = validate({ ...body, rubric: body.rubric ?? item.rubric }, true);
        if (Object.keys(errors).length) {
          return reply.code(400).send(errors);
        }
        Object.assign(item, body);
        if (body.images !== undefined) {
          item.images = (body.images as unknown[]).slice(0, MAX_IMAGES).map(Number);
        }
        return serialize(item);
      });

      api.post('/items/toggle_active/:id/', async (req, reply) => {
        const item = ownedItem(req, reply);
        if (!item) {
          return reply;
        }
        item.status = item.status === 2 ? 0 : 2;
        return { status: item.status };
      });

      api.post('/items/to_remove/:id/', async (req, reply) => {
        const item = ownedItem(req, reply);
        if (!item) {
          return reply;
        }
        state.items.delete(item.id);
        return { status: 0 };
      });

      api.get('/items/front_my/', async (req, reply) => {
        const user = requireUser(req, reply);
        if (!user) {
          return reply;
        }
        const page = Math.max(1, Number((req.query as { page?: string }).page ?? 1));
        const mine = [...state.items.values()]
          .filter((i) => i.ownerPhone === user.phone)
          .sort((a, b) => b.id - a.id);
        const results = mine.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(serialize);
        const hasNext = page * PAGE_SIZE < mine.length;
        return {
          count: mine.length,
          next: hasNext ? `${PREFIX}/items/front_my/?page=${page + 1}` : null,
          previous: page > 1 ? `${PREFIX}/items/front_my/?page=${page - 1}` : null,
          results,
        };
      });

      api.get('/items/tree_v2/', async () => RUBRIC_TREE);
      api.get('/items/rubric_form/:id/', async (req, reply) => {
        const form = RUBRIC_FORMS[Number((req.params as { id: string }).id)];
        return form ?? reply.code(404).send({ detail: 'Not found.' });
      });
      api.get('/items/all_cities/', async () => REGIONS);
      api.get('/items/city_districts/:id/', async (req) => {
        const cityId = Number((req.params as { id: string }).id);
        return [
          { id: cityId * 100 + 1, name: 'District A', city: cityId },
          { id: cityId * 100 + 2, name: 'District B', city: cityId },
        ];
      });
    },
    { prefix: PREFIX },
  );

  const control: FakePinControl = {
    get state() {
      return state;
    },
    failNext(fault) {
      faults.push({ ...fault, times: fault.times ?? 1 });
    },
    cloudflareBlockAll(enabled) {
      state.cloudflareAll = enabled;
    },
    revokeToken(phone) {
      const user = state.users.get(digits(phone));
      if (user) {
        user.token = randomUUID().replace(/-/g, '');
      }
    },
    setModeration(itemId, status, comment = null) {
      const item = state.items.get(itemId);
      if (!item) {
        throw new Error(`fake-pin: no item ${itemId}`);
      }
      item.status = status;
      item.moderator_comment = comment;
    },
    smsCode: () => smsCode,
    callCount: (route) => state.calls.filter((c) => c.route === route).length,
    reset() {
      state = new FakePinState();
      faults.length = 0;
    },
  };

  return { app, control };
}

export async function startFakePin(
  options: FakePinOptions & { port?: number; host?: string } = {},
): Promise<FakePin> {
  const { app, control } = buildFakePin(options);
  const address = await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  return { app, url: address, control, close: () => app.close() };
}
