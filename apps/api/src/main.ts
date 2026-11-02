import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import type { Env } from './config/env.js';
import { ENV } from './core/tokens.js';
import { startInternalTls } from './internal-tls.js';
import { startMetricsServer } from './metrics/metrics.js';

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen(env.PORT);
const internal = await startInternalTls(app, env);
const metrics = await startMetricsServer({
  port: env.METRICS_PORT,
  rspamdUrl: env.RSPAMD_CONTROLLER_URL,
  rspamdPassword: env.RSPAMD_CONTROLLER_PASSWORD,
});
const close = () => {
  internal?.close();
  metrics?.close();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
new Logger('Bootstrap').log(`Listening on port ${env.PORT}${env.METRICS_PORT ? `, metrics on ${env.METRICS_PORT}` : ''}`);
