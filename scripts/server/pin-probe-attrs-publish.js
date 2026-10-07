// Finds the attrs shape Pin's POST /items/ accepts by REALLY publishing, on the bridge server.
// validate_ad is broken on prod (500) and Pin checks attrs only after the base fields pass, so
// there is no dry run. Shapes are tried one by one with valid base fields: a wrong shape gets a
// 400 "attrs__... can not be empty" and creates nothing; the first accepted one creates an item,
// which is removed right away (POST /items/to_remove/<id>/). Stops after the first success.
//
//   docker compose run --rm -T worker node - +18686813498 20 < pin-probe-attrs-publish.js
//
// Uses one connection's stored credentials; the device key and token are decrypted inside the
// worker container and never printed.
const { createDecipheriv } = require('node:crypto');
const { Client } = require('pg');

const [phone, rubricArg] = process.argv.slice(2);
const rubric = Number(rubricArg || 20);
if (!phone) {
  console.error('usage: node - <phone_e164> [rubric] < pin-probe-attrs-publish.js');
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

const short = (text) => (/^\s*</.test(text) ? '(HTML error page)' : text.slice(0, 1500));

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
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  };

  const form = await (await fetch(`${base}/items/rubric_form/${rubric}/`, { headers })).json();
  const required = (form.rubric_features || []).filter((f) => f.required && !f.geo);
  // A realistic choice where one exists (2nd variant), a real village name for text fields.
  const values = {};
  for (const f of required) {
    const choices = f.feature_choices || [];
    const raw = choices.length ? (choices[1] || choices[0]).key : 'St. Ann\'s';
    values[f.feature_name.replace(/^attrs__/, '')] = /^\d+$/.test(String(raw)) ? Number(raw) : raw;
  }
  const prefixed = Object.fromEntries(Object.entries(values).map(([k, v]) => [`attrs__${k}`, v]));
  const asStrings = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
  console.log(`Attribute values: ${JSON.stringify(values)}`);

  const common = {
    rubric,
    city: 17,
    currency_id: 1,
    title: 'Test listing, please ignore',
    description:
      'Technical test of the listing integration. This listing is removed immediately and is not for sale.',
    price: 1500000,
    images: [],
    coordinates: { latitude: 10.65, longitude: -61.41 },
    user: { name: 'Duck Realty Agent', email: '' },
    phone_hide: false,
    negotiable_price: false,
    item_link: '',
  };
  const shapes = {
    'S1 top-level attrs__slug: key': { attrs: {}, ...prefixed },
    'S2 attrs: {attrs__slug: key}': { attrs: prefixed },
    'S3 attrs: {slug: "key"} strings': { attrs: asStrings },
    'S4 attrs: {slug: key} (what the bridge sends now)': { attrs: values },
  };

  for (const [name, extra] of Object.entries(shapes)) {
    const body = { ...common, external_id: `probe-${Date.now()}`, ...extra };
    const res = await post('/items/', body);
    console.log(`\n${name}\n  HTTP ${res.status}: ${short(res.text)}`);
    if (res.status >= 300) {
      continue;
    }
    let itemId;
    try {
      itemId = JSON.parse(res.text).id;
    } catch {
      // handled below
    }
    console.log(`\n>>> ACCEPTED: ${name}. Pin item id: ${itemId ?? '(not found in response)'}`);
    if (!itemId) {
      console.log('!!! Could not read the item id. Delete "Test listing, please ignore" in the Pin app.');
      return;
    }
    const removed = await post(`/items/to_remove/${encodeURIComponent(itemId)}/`);
    console.log(`  to_remove: HTTP ${removed.status}: ${short(removed.text)}`);
    if (removed.status >= 300) {
      console.log('!!! Removal failed. Delete "Test listing, please ignore" in the Pin app.');
    }
    return;
  }
  console.log('\nNo shape was accepted; nothing was created.');
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
