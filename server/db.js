import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB_PATH = fileURLToPath(new URL('../data/muse.sqlite', import.meta.url));

// Store only the explicitly validated melody document. Original microphone
// recordings never enter this schema or leave the browser.
export function openProjectDatabase(dbPath = DEFAULT_DB_PATH) {
  const filename = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL,
      settings TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_updated_at ON projects(updated_at DESC);
    PRAGMA user_version = 1;
  `);
  const selectAll = database.prepare('SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC');
  const selectOne = database.prepare('SELECT * FROM projects WHERE id = ?');
  const upsert = database.prepare(`
    INSERT INTO projects (id, title, notes, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      notes = excluded.notes,
      settings = excluded.settings,
      updated_at = excluded.updated_at
  `);
  function projectFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      notes: JSON.parse(row.notes),
      settings: JSON.parse(row.settings),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return {
    connection: database,
    list() { return selectAll.all().map(projectFromRow); },
    get(id) { return projectFromRow(selectOne.get(id)); },
    save(project) {
      const updatedAt = new Date().toISOString();
      upsert.run(project.id, project.title, JSON.stringify(project.notes), JSON.stringify(project.settings), project.createdAt, updatedAt);
      return projectFromRow(selectOne.get(project.id));
    },
    close() { database.close(); },
  };
}
