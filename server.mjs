import { createSwooshPay } from './app.mjs';
import { openStore } from './store.mjs';

const port = Number(process.env.PORT || 8787);
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:' + port).origin;
const db = openStore(process.env.DATABASE_PATH || 'data/handlepay.db');
createSwooshPay({ db, origin }).listen(port, process.env.HOST || '127.0.0.1', () => console.log('swoosh.pay listening at ' + origin));
