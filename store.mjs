import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0002_discord_installations.sql', import.meta.url), 'utf8'));
  const columns = db.prepare("SELECT name FROM pragma_table_info('payments')").all().map(column => column.name);
  if (!columns.includes('discord_token')) {
    db.exec(readFileSync(new URL('./migrations/0003_discord_fast_pay.sql', import.meta.url), 'utf8'));
  }
  return {
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    close: () => db.close()
  };
}

