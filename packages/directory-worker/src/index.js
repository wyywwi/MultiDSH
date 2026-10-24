// Cloudflare Worker entry for the MultiDSH directory.
//
// Production uses the D1 binding `FLEET_DB`. Without it (local `wrangler dev`)
// the Worker falls back to a per-isolate memory store so the API can still be
// smoke-tested; that mode is not durable.

import { createDirectoryApp } from './src/app.js';
import { D1Repository, MemoryKv, Repository } from './src/storage.js';

let fallbackKv = null;

export default {
  async fetch(request, env) {
    let repo;
    if (env && env.FLEET_DB) {
      repo = new D1Repository({ db: env.FLEET_DB });
    } else {
      fallbackKv = fallbackKv || new MemoryKv();
      repo = new Repository({ kv: fallbackKv });
    }
    const app = createDirectoryApp({
      repo,
      rateLimiters: {
        createPool: env && env.CREATE_POOL_RATE_LIMITER,
        join: env && env.JOIN_RATE_LIMITER,
      },
      createPoolKey: (env && env.CREATE_POOL_KEY) || '',
    });
    return app.fetch(request);
  },
};
