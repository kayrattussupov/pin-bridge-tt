import { createHttpApp, listen } from './bootstrap';
import { loadEnv } from './config/env';
import { WorkerModule } from './worker/worker.module';

async function main(): Promise<void> {
  const env = loadEnv();
  // The worker only serves /health; agency traffic never reaches it.
  const app = await createHttpApp(WorkerModule, { trustProxy: false, bodyLimit: 1024 });
  await listen(app, env.WORKER_HEALTH_HOST, env.WORKER_HEALTH_PORT);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
