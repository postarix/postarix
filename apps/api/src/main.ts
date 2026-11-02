import { createApp } from './bootstrap.js';
import type { Env } from './config/env.js';
import { ENV } from './core/tokens.js';

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen(env.PORT);
console.log(`Postarix API listening on port ${env.PORT}`);
