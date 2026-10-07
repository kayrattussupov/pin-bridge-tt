// GET a pin.tt path with the stored Pin credentials of one connection (by phone), on the bridge
// server. The device key and token are decrypted inside the worker container and never printed.
//
//   docker compose run --rm -T worker node - +18686813498 /items/rubric_form/21/ \
//     < pin-as-connection.js > /root/rubric21.json
//
// Prints the response body to stdout, "HTTP <status>" to stderr. GET only: it changes nothing.
const { createDecipheriv } = require('node:crypto');
const { Client } = require('pg');

const [phone, path] = process.argv.slice(2);
if (!phone || !path || !path.startsWith('/')) {
  console.error('usage: node - <phone_e164> </pin/path/> < pin-as-connection.js');
  process.exit(2);
}

const keys = new Map();
for (const entry of (process.env.ENCRYPTION_PREVIOUS_KEYS || '').split(',').filter(Boolean)) {
  const [id, key] = entry.split(':');
  keys.set(id, Buffer.from(key, 'base64'));
}
keys.set(process.env.ENCRYPTION_KEY_ID || 'k1',Buffer.from(process.env.ENCRYPTION_KEY, 'base64'));

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
  const base = (process.env.PIN_BASE_URL || 'https://pin.tt').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1.6${path}`, {
    headers: {
      'device-api-key': decrypt(rows[0].pin_device_key_enc, `connection:${id}:device_key`),
      authorization: `Token ${decrypt(rows[0].pin_token_enc, `connection:${id}:token`)}`,
      accept: 'application/json',
    },
  });
  process.stdout.write(await res.text());
  console.error(`\nHTTP ${res.status} (connection ${id})`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
