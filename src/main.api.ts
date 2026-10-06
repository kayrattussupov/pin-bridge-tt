import { ApiModule } from './api/api.module';
import { apiOptions, createHttpApp, listen } from './bootstrap';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createHttpApp(ApiModule, apiOptions(env));
  await listen(app, env.API_HOST, env.API_PORT);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
