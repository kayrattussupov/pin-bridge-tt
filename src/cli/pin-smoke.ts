/**
 * Checks from the allowlisted server that Pin is reachable and the flow works:
 *
 *   node dist/cli/pin-smoke.js                                   stored device key + dictionary
 *   node dist/cli/pin-smoke.js --phone +1868XXXXXXX              new device key + SMS code
 *   node dist/cli/pin-smoke.js --device-key K --phone P --code C ...and exchange it for a token
 *
 * Every new device key is a new (empty) user on Pin, so without --phone the check reuses Pin
 * Bridge's stored system device key (the one dictionaries use; created once if missing). A login
 * test gets its own new key, like a real connection, so its SMS limit stays separate.
 *
 * In production: `docker compose run --rm worker node dist/cli/pin-smoke.js [...]`.
 * Never prints the user token, only whether one was issued.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';
import { version } from '../../package.json';
import { AuditModule } from '../audit/audit.module';
import { ConfigModule } from '../config/config.module';
import { loadEnv } from '../config/env';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { DictionariesService } from '../dictionaries/dictionaries.service';
import { QueueModule } from '../queue/queue.module';
import { PinClient, PinLogger } from '../pin/pin.client';
import { isPinError } from '../pin/pin.errors';
import { maskPhone } from '../pin/mask';
import { pinClientOptionsFromEnv } from '../pin/pin.options';

const HINTS: Partial<Record<string, string>> = {
  cloudflare_blocked:
    'Cloudflare blocked the request: this server IP is not in the Pin allowlist ' +
    '(or PIN_HTTPS_PROXY does not point at the allowlisted egress).',
  missing_device_key: 'Pin did not accept the Device-Api-Key.',
  breaker_open: 'The circuit breaker is open after recent failures; wait and retry.',
};

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    QueueModule,
    DictionariesModule,
  ],
})
class SmokeModule {}

/** Pin Bridge's stored system device key (created and stored once if missing). */
async function storedDeviceKey(): Promise<string> {
  const app = await NestFactory.createApplicationContext(SmokeModule, { logger: ['error'] });
  try {
    return await app.get(DictionariesService).systemDeviceKey();
  } finally {
    await app.close();
  }
}

const quietLogger: PinLogger = {
  debug: () => undefined,
  warn: (obj, msg) => console.error(`  ${msg}`, JSON.stringify(obj)),
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      code: { type: 'string' },
      'device-key': { type: 'string' },
    },
  });
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const client = new PinClient(
    pinClientOptionsFromEnv(env, `PinBridge/${version} (smoke)`),
    redis,
    quietLogger,
  );
  const step = (text: string) => console.log(`- ${text}`);

  try {
    console.log(`Pin smoke test against ${env.PIN_BASE_URL}`);
    let deviceKey = values['device-key'];
    if (deviceKey) {
      step(`using device key ${deviceKey}`);
    } else if (values.phone) {
      deviceKey = await client.createDeviceKey();
      step(`device key created for this login: ${deviceKey}`);
    } else {
      deviceKey = await storedDeviceKey();
      step(`using the stored system device key ${deviceKey.slice(0, 8)}…`);
    }

    const cities = await client.getAllCities(deviceKey);
    step(`all_cities OK (${Array.isArray(cities) ? cities.length : '?'} entries)`);

    if (values.phone && !values.code) {
      const { retryAfterSeconds } = await client.requestSmsCode(deviceKey, values.phone);
      step(
        `SMS requested for ${maskPhone(values.phone)}` +
          (retryAfterSeconds !== undefined
            ? `, next request allowed in ${retryAfterSeconds}s`
            : ''),
      );
      step(`confirm with: --device-key ${deviceKey} --phone ${values.phone} --code <code>`);
    }
    if (values.phone && values.code) {
      const token = await client.confirmSmsCode(deviceKey, values.phone, values.code);
      step(`token issued (${token.length} chars, not shown)`);
    }
    console.log('OK');
    return 0;
  } catch (error) {
    if (isPinError(error)) {
      console.error(`FAILED: ${error.message}`);
      const hint = HINTS[error.kind];
      if (hint) {
        console.error(`hint: ${hint}`);
      }
      if (error.smsRetryAfterSeconds !== undefined) {
        console.error(`hint: Pin allows the next SMS request in ${error.smsRetryAfterSeconds}s`);
      }
    } else {
      console.error('FAILED:', error);
    }
    return 1;
  } finally {
    await client.close();
    redis.disconnect();
  }
}

main().then((code) => process.exit(code));
