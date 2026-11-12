import { httpServerHandler } from 'cloudflare:node';
import { env, waitUntil } from 'cloudflare:workers';
import { createSwooshPay } from './app.mjs';

const query = (sql, params) => env.DB.prepare(sql).bind(...params);
const db = {
  get: (sql, ...params) => query(sql, params).first(),
  all: async (sql, ...params) => (await query(sql, params).all()).results,
  run: async (sql, ...params) => ({ changes: (await query(sql, params).run()).meta.changes })
};

export default httpServerHandler(createSwooshPay({ db, origin: env.APP_ORIGIN, background: waitUntil }));
