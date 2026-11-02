import { createApp } from './bootstrap.js';
import type { Env } from './config/env.js';
import { ENV } from './core/tokens.js';
import { startInternalTls } from './internal-tls.js';

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen(env.PORT);
const internal = await startInternalTls(app, env);
const close = () => internal?.close();
process.once('SIGTERM', close);
process.once('SIGINT', close);
console.log(`Postarix API listening on port ${env.PORT}`);
