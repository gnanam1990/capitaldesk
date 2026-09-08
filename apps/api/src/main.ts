import { loadApiConfig } from '@capitaldesk/config';
import { buildServer } from './server.js';

const config = loadApiConfig();
const app = buildServer(config);

await app.listen({ port: config.httpPort, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
