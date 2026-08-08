/** Entry point for `npm run init-db`. Creates the database file and schema. */

import { config } from '../config.js';
import { openDb } from './index.js';

const db = openDb(config.dbPath);

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all() as Array<{ name: string }>;

db.close();

console.log(`Database ready at ${config.dbPath}`);
console.log(`Tables: ${tables.map((t) => t.name).join(', ')}`);
