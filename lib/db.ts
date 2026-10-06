import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic, type BindParams } from "sql.js";
import { databasePath } from "./paths";

type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

let sqlPromise: Promise<SqlJsStatic> | null = null;
let dbPromise: Promise<Database> | null = null;

function sqlWasmPath(file: string): string {
  return path.join(process.cwd(), "node_modules", "sql.js", "dist", file);
}

async function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: sqlWasmPath });
  return sqlPromise;
}

function mapRow(row: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (typeof value === "number" || typeof value === "string" || value === null) out[key] = value;
    else if (value === undefined) out[key] = null;
    else out[key] = String(value);
  }
  return out;
}

export async function openDatabase(): Promise<Database> {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const SQL = await getSql();
    const dbFile = databasePath();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = fs.existsSync(dbFile) ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
    db.run("PRAGMA foreign_keys = ON");
    applySchema(db);
    persistDatabase(db);
    return db;
  })();

  return dbPromise;
}

export function resetDatabaseConnectionForTests(): void {
  dbPromise = null;
}

export function persistDatabase(db: Database): void {
  const dbFile = databasePath();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, Buffer.from(db.export()));
}

export async function withDatabase<T>(fn: (db: Database) => T): Promise<T> {
  const db = await openDatabase();
  const result = fn(db);
  persistDatabase(db);
  return result;
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function run(db: Database, sql: string, params: BindParams = []): void {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

export function all<T extends Row = Row>(db: Database, sql: string, params: BindParams = []): T[] {
  const stmt = db.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(mapRow(stmt.getAsObject()) as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function get<T extends Row = Row>(db: Database, sql: string, params: BindParams = []): T | null {
  return all<T>(db, sql, params)[0] ?? null;
}

export function scalar(db: Database, sql: string, params: BindParams = []): number {
  const row = get<{ value: number }>(db, sql, params);
  return Number(row?.value ?? 0);
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(all<{ name: string }>(db, `PRAGMA table_info(${table})`).map((row) => row.name));
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  if (!columnNames(db, table).has(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function rebuildRepositoriesIfNeeded(db: Database): void {
  const schema = get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repositories'")?.sql ?? "";
  if (!schema || schema.includes("'zip'")) return;

  db.run("PRAGMA foreign_keys = OFF");
  db.run(`
    ALTER TABLE repositories RENAME TO repositories_old;
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('url', 'path', 'zip')),
      source TEXT NOT NULL,
      local_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'cloning', 'extracting', 'analyzing', 'indexing', 'ready', 'failed')),
      error_message TEXT,
      commit_count INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      current_stage TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO repositories (id, name, source_type, source, local_path, status, error_message, commit_count, progress, current_stage, created_at, updated_at)
      SELECT id, name, source_type, source, local_path,
             CASE status WHEN 'analyzing' THEN 'analyzing' WHEN 'ready' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'pending' END,
             error_message, commit_count,
             CASE status WHEN 'ready' THEN 100 ELSE 0 END,
             status, created_at, updated_at
      FROM repositories_old;
    DROP TABLE repositories_old;
  `);
  db.run("PRAGMA foreign_keys = ON");
}

export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('url', 'path', 'zip')),
      source TEXT NOT NULL,
      local_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'cloning', 'extracting', 'analyzing', 'indexing', 'ready', 'failed')),
      error_message TEXT,
      commit_count INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      current_stage TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      UNIQUE(repository_id, name, email)
    );

    CREATE TABLE IF NOT EXISTS commits (
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      sha TEXT NOT NULL,
      parent_sha TEXT,
      author_id INTEGER NOT NULL REFERENCES authors(id),
      raw_author_name TEXT NOT NULL DEFAULT '',
      raw_author_email TEXT NOT NULL DEFAULT '',
      committer_date INTEGER NOT NULL,
      subject TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(repository_id, sha)
    );

    CREATE TABLE IF NOT EXISTS changes (
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      path TEXT NOT NULL,
      added INTEGER NOT NULL,
      removed INTEGER NOT NULL,
      PRIMARY KEY(repository_id, commit_sha, path)
    );

    CREATE TABLE IF NOT EXISTS dir_metrics (
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      dir_path TEXT NOT NULL,
      added INTEGER NOT NULL,
      removed INTEGER NOT NULL,
      PRIMARY KEY(repository_id, commit_sha, dir_path)
    );

    CREATE TABLE IF NOT EXISTS object_lifetimes (
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
      path TEXT NOT NULL,
      first_ordinal INTEGER NOT NULL,
      last_ordinal INTEGER NOT NULL,
      PRIMARY KEY(repository_id, kind, path)
    );

    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      stage TEXT NOT NULL CHECK (stage IN ('queued', 'cloning', 'extracting', 'parsing', 'indexing', 'done', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  rebuildRepositoriesIfNeeded(db);
  addColumnIfMissing(db, "repositories", "progress", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "repositories", "current_stage", "TEXT NOT NULL DEFAULT 'pending'");
  addColumnIfMissing(db, "commits", "raw_author_name", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "commits", "raw_author_email", "TEXT NOT NULL DEFAULT ''");

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_repositories_status ON repositories(status);
    CREATE INDEX IF NOT EXISTS idx_authors_repo ON authors(repository_id);
    CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits(repository_id, committer_date);
    CREATE INDEX IF NOT EXISTS idx_commits_repo_author ON commits(repository_id, author_id);
    CREATE INDEX IF NOT EXISTS idx_changes_repo_path_sha ON changes(repository_id, path, commit_sha);
    CREATE INDEX IF NOT EXISTS idx_changes_repo_commit_path ON changes(repository_id, commit_sha, path);
    CREATE INDEX IF NOT EXISTS idx_dir_metrics_repo_dir_sha ON dir_metrics(repository_id, dir_path, commit_sha);
    CREATE INDEX IF NOT EXISTS idx_dir_metrics_repo_commit_dir ON dir_metrics(repository_id, commit_sha, dir_path);
    CREATE INDEX IF NOT EXISTS idx_object_lifetimes_repo_kind_path ON object_lifetimes(repository_id, kind, path);
    CREATE INDEX IF NOT EXISTS idx_object_lifetimes_repo_kind_first ON object_lifetimes(repository_id, kind, first_ordinal);
    CREATE INDEX IF NOT EXISTS idx_jobs_repo ON ingest_jobs(repository_id, updated_at);
  `);
}
