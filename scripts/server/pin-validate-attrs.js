// Dry-runs Pin's POST /items/validate_ad/ (creates nothing) with the same attributes sent in three
// body shapes, to see which one Pin reads. Uses one connection's stored credentials, on the bridge
// server; the device key and token are decrypted inside the worker container and never printed.
//
//   docker compose run --rm -T worker node - +18686813498 20 < pin-validate-attrs.js
//   docker compose run --rm -T worker node - +18686813498 20 probe < pin-validate-attrs.js
//
// "probe" also sends POST /items/ with an item_link, which Pin refuses in rubric 20 (see below).
//
// Prints the required features of the rubric form, then Pin's answer for each shape.
const { createDecipheriv } = require('node:crypto');
const { Client } = require('pg');

const [phone, rubricArg] = process.argv.slice(2);
const rubric = Number(rubricArg || 20);
if (!phone) {
  console.error('usage: node - <phone_e164> [rubric] < pin-validate-attrs.js');
  process.exit(2);
}

const keys = new Map();
for (const entry of (process.env.ENCRYPTION_PREVIOUS_KEYS || '').split(',').filter(Boolean)) {
  const [id, key] = entry.split(':');
  keys.set(id, Buffer.from(key, 'base64'));
}
keys.set(process.env.ENCRYPTION_KEY_ID || 'k1', Buffer.from(process.env.ENCRYPTION_KEY, 'base64'));

// Same layout as src/crypto/encryption.service.ts: version | keyIdLength | keyId | iv | tag | data.
function decrypt(payload, context) {
  const buf = Buffer.from(payload);
  const keyIdLength = buf[1];
  const key = keys.get(buf.subarray(2, 2 + keyIdLength).toString('utf8'));
  let offset = 2 + keyIdLength;
  const iv = buf.subarray(offset, (offset += 12));
  const tag = buf.subarray(offset, (offset += 16));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(offset)), decipher.final()]).toString('utf8');
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    `select id, pin_device_key_enc, pin_token_enc from connections
     where phone_e164 = $1 and status = 'active' and pin_token_enc is not null
     order by updated_at desc limit 1`,
    [phone],
  );
  await db.end();
  if (!rows.length) {
    console.error(`no active connection with a token for ${phone}`);
    process.exit(1);
  }
  const { id } = rows[0];
  const headers = {
    'device-api-key': decrypt(rows[0].pin_device_key_enc, `connection:${id}:device_key`),
    authorization: `Token ${decrypt(rows[0].pin_token_enc, `connection:${id}:token`)}`,
    accept: 'application/json',
  };
  const base = `${(process.env.PIN_BASE_URL || 'https://pin.tt').replace(/\/$/, '')}/api/v1.6`;

  const form = await (await fetch(`${base}/items/rubric_form/${rubric}/`, { headers })).json();
  const required = (form.rubric_features || []).filter((f) => f.required && !f.geo);
  console.log('Required features:');
  for (const f of required) {
    const choices = (f.feature_choices || []).slice(0, 3).map((c) => `${c.key}=${c.value}`);
    console.log(`  ${f.feature_name} [${f.feature_type}] ${choices.join(', ')}`);
  }

  // First choice of each select, a sample text otherwise; key as number when numeric.
  const values = {};
  for (const f of required) {
    const choice = (f.feature_choices || [])[0];
    const raw = choice ? choice.key : 'Test';
    values[f.feature_name.replace(/^attrs__/, '')] = /^\d+$/.test(String(raw)) ? Number(raw) : raw;
  }
  const prefixed = Object.fromEntries(Object.entries(values).map(([k, v]) => [`attrs__${k}`, v]));
  // Same fields as the bridge's POST /items/ body (src/listings/listing-mapper.ts).
  const common = {
    rubric,
    city: 17,
    currency_id: 1,
    title: 'Pin Bridge validation test, please ignore',
    description: 'Dry run of validate_ad only. Nothing is published.',
    price: 100000,
    images: [],
    coordinates: { latitude: 10.65, longitude: -61.41 },
    user: { name: 'Pin Bridge Test', email: '' },
    phone_hide: false,
    negotiable_price: false,
    external_id: `validate-test-${Date.now()}`,
    item_link: '',
  };
  const shapes = {
    'A  attrs: {slug: key}         (what the bridge sends)': { ...common, attrs: values },
    'B  attrs: {attrs__slug: key}': { ...common, attrs: prefixed },
    'C  top-level attrs__slug: key': { ...common, ...prefixed },
    'D  attrs: {slug: "key"} strings': {
      ...common,
      attrs: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
    },
  };
  for (const [name, body] of Object.entries(shapes)) {
    const res = await fetch(`${base}/items/validate_ad/`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`\n${name}\n  sent attrs: ${JSON.stringify(body.attrs ?? prefixed)}`);
    const text = await res.text();
    const html = /^\s*</.test(text);
    console.log(`  HTTP ${res.status}: ${html ? '(HTML error page, Pin crashed)' : text.slice(0, 1500)}`);
  }

  console.log('\nIf all shapes return 500 here too, validate_ad itself is broken on Pin.');

  // validate_ad is broken on prod (500). In rubric 20 Pin refuses any item_link with a 400, so a
  // POST /items/ carrying one should be rejected and create nothing, yet the answer shows whether
  // Pin also complains about attrs. Opt-in: pass "probe" as the third argument.
  if (process.argv[4] !== 'probe') {
    return;
  }
  const link = 'https://example.com/pin-bridge-probe';
  const probes = {
    'P1 item_link + no attrs (baseline: are attrs errors listed next to item_link?)': {
      attrs: {},
    },
    'P2 item_link + attrs: {slug: key} (what the bridge sends)': { attrs: values },
    'P3 item_link + top-level attrs__slug: key': { attrs: {}, ...prefixed },
  };
  for (const [name, extra] of Object.entries(probes)) {
    const body = { ...common, external_id: `probe-${Date.now()}`, item_link: link, ...extra };
    const res = await fetch(`${base}/items/`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n${name}`);
    console.log(`  HTTP ${res.status}: ${/^\s*</.test(text) ? '(HTML error page)' : text.slice(0, 1500)}`);
    if (res.status < 300) {
      console.log('  !!! Pin CREATED an item. Delete it in the Pin app. Stopping.');
      return;
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
