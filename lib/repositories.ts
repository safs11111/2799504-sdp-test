import type { Database } from "sql.js";
import { all, get, run, scalar, transaction, withDatabase } from "./db";
import type { Author, CommitRecord, DirMetric, FileChange, RepoSourceType, RepoStatus, Repository } from "./types";

type RepoRow = {
  id: number;
  name: string;
  source_type: RepoSourceType;
  source: string;
  local_path: string;
  status: RepoStatus;
  error_message: string | null;
  commit_count: number;
  created_at: number;
  updated_at: number;
};

type AuthorRow = {
  id: number;
  repository_id: number;
  name: string;
  email: string;
  display_name: string;
};

function toRepository(row: RepoRow): Repository {
  return {
    id: Number(row.id),
    name: row.name,
    sourceType: row.source_type,
    source: row.source,
    localPath: row.local_path,
    status: row.status,
    errorMessage: row.error_message,
    commitCount: Number(row.commit_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toAuthor(row: AuthorRow): Author {
  return {
    id: Number(row.id),
    repositoryId: Number(row.repository_id),
    name: row.name,
    email: row.email,
    displayName: row.display_name,
  };
}

export async function createRepository(input: {
  name: string;
  sourceType: RepoSourceType;
  source: string;
  localPath: string;
}): Promise<Repository> {
  return withDatabase((db) => {
    const now = Math.floor(Date.now() / 1000);
    run(
      db,
      `INSERT INTO repositories (name, source_type, source, local_path, status, error_message, commit_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, 0, ?, ?)`,
      [input.name, input.sourceType, input.source, input.localPath, now, now],
    );
    const id = scalar(db, "SELECT last_insert_rowid() AS value");
    return getRepositoryByIdInDb(db, id)!;
  });
}

export async function listRepositories(): Promise<Repository[]> {
  return withDatabase((db) => all<RepoRow>(db, "SELECT * FROM repositories ORDER BY updated_at DESC").map(toRepository));
}

export async function getRepositoryById(id: number): Promise<Repository | null> {
  return withDatabase((db) => getRepositoryByIdInDb(db, id));
}

export function getRepositoryByIdInDb(db: Database, id: number): Repository | null {
  const row = get<RepoRow>(db, "SELECT * FROM repositories WHERE id = ?", [id]);
  return row ? toRepository(row) : null;
}

export async function updateRepositoryStatus(
  id: number,
  status: RepoStatus,
  errorMessage: string | null = null,
  commitCount?: number,
): Promise<void> {
  await withDatabase((db) => {
    run(
      db,
      `UPDATE repositories
       SET status = ?, error_message = ?, commit_count = COALESCE(?, commit_count), updated_at = ?
       WHERE id = ?`,
      [status, errorMessage, commitCount ?? null, Math.floor(Date.now() / 1000), id],
    );
  });
}

export async function updateRepositoryLocalPath(id: number, localPath: string): Promise<void> {
  await withDatabase((db) => {
    run(db, "UPDATE repositories SET local_path = ?, updated_at = ? WHERE id = ?", [
      localPath,
      Math.floor(Date.now() / 1000),
      id,
    ]);
  });
}

export async function listAuthors(repositoryId: number): Promise<Author[]> {
  return withDatabase((db) =>
    all<AuthorRow>(db, "SELECT * FROM authors WHERE repository_id = ? ORDER BY display_name", [repositoryId]).map(toAuthor),
  );
}

export function findOrCreateAuthor(db: Database, repositoryId: number, name: string, email: string): number {
  const existing = get<{ id: number }>(
    db,
    "SELECT id FROM authors WHERE repository_id = ? AND name = ? AND email = ?",
    [repositoryId, name, email],
  );
  if (existing) return Number(existing.id);

  const displayName = email ? `${name} <${email}>` : name;
  run(db, "INSERT INTO authors (repository_id, name, email, display_name) VALUES (?, ?, ?, ?)", [
    repositoryId,
    name,
    email,
    displayName,
  ]);
  return scalar(db, "SELECT last_insert_rowid() AS value");
}

export async function replaceRepositoryAnalysis(input: {
  repositoryId: number;
  commits: CommitRecord[];
  changes: FileChange[];
  dirMetrics: DirMetric[];
}): Promise<void> {
  await withDatabase((db) => {
    transaction(db, () => {
      run(db, "DELETE FROM dir_metrics WHERE repository_id = ?", [input.repositoryId]);
      run(db, "DELETE FROM changes WHERE repository_id = ?", [input.repositoryId]);
      run(db, "DELETE FROM commits WHERE repository_id = ?", [input.repositoryId]);

      const commitStmt = db.prepare(
        `INSERT INTO commits (repository_id, sha, parent_sha, author_id, committer_date, subject, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const commit of input.commits) {
          commitStmt.run([
            commit.repositoryId,
            commit.sha,
            commit.parentSha,
            commit.authorId,
            commit.committerDate,
            commit.subject,
            commit.ordinal,
          ]);
        }
      } finally {
        commitStmt.free();
      }

      const changeStmt = db.prepare(
        `INSERT INTO changes (repository_id, commit_sha, path, added, removed)
         VALUES (?, ?, ?, ?, ?)`,
      );
      try {
        for (const change of input.changes) {
          changeStmt.run([change.repositoryId, change.commitSha, change.path, change.added, change.removed]);
        }
      } finally {
        changeStmt.free();
      }

      const dirStmt = db.prepare(
        `INSERT INTO dir_metrics (repository_id, commit_sha, dir_path, added, removed)
         VALUES (?, ?, ?, ?, ?)`,
      );
      try {
        for (const dir of input.dirMetrics) {
          dirStmt.run([dir.repositoryId, dir.commitSha, dir.dirPath, dir.added, dir.removed]);
        }
      } finally {
        dirStmt.free();
      }

      run(
        db,
        "UPDATE repositories SET status = 'ready', error_message = NULL, commit_count = ?, updated_at = ? WHERE id = ?",
        [input.commits.length, Math.floor(Date.now() / 1000), input.repositoryId],
      );
    });
  });
}
