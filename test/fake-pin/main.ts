// Local stand-in for pin.tt: `npm run fake-pin`, then run the bridge with
// PIN_BASE_URL=http://localhost:4010. SMS code is always the one printed below.
import { startFakePin } from './fake-pin';

async function main(): Promise<void> {
  const port = Number(process.env.FAKE_PIN_PORT ?? 4010);
  const fake = await startFakePin({ port, host: process.env.FAKE_PIN_HOST ?? '127.0.0.1' });
  console.log(`fake-pin listening on ${fake.url} (SMS code: ${fake.control.smsCode()})`);
  const stop = () => void fake.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
