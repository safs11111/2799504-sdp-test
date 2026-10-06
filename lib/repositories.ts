import type { Database } from "sql.js";
import { all, get, run, scalar, transaction, withDatabase } from "./db";
import type { Author, CommitRecord, DirMetric, FileChange, IngestJob, JobStage, JobStatus, RepoSourceType, RepoStatus, Repository } from "./types";

type RepoRow = {
  id: number;
  name: string;
  source_type: RepoSourceType;
  source: string;
  local_path: string;
  status: RepoStatus;
  error_message: string | null;
  commit_count: number;
  progress: number;
  current_stage: string;
  created_at: number;
  updated_at: number;
};

type AuthorRow = {
  id: number;
  repository_id: number;
  name: string;
  email: string;
  display_name: string;
  commit_count: number;
};

type JobRow = {
  id: number;
  repository_id: number;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  message: string;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

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
    progress: Number(row.progress),
    currentStage: row.current_stage,
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
    commitCount: Number(row.commit_count),
  };
}

function toJob(row: JobRow): IngestJob {
  return {
    id: Number(row.id),
    repositoryId: Number(row.repository_id),
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress),
    message: row.message,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

export async function createRepository(input: {
  name: string;
  sourceType: RepoSourceType;
  source: string;
  localPath: string;
}): Promise<Repository> {
  return withDatabase((db) => {
    const timestamp = now();
    run(
      db,
      `INSERT INTO repositories (name, source_type, source, local_path, status, error_message, commit_count, progress, current_stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, 0, 0, 'pending', ?, ?)`,
      [input.name, input.sourceType, input.source, input.localPath, timestamp, timestamp],
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
  await updateRepositoryProgress(id, status, status, status === "ready" ? 100 : undefined, errorMessage, commitCount);
}

export async function updateRepositoryProgress(
  id: number,
  status: RepoStatus,
  stage: string,
  progress?: number,
  errorMessage: string | null = null,
  commitCount?: number,
): Promise<void> {
  await withDatabase((db) => {
    run(
      db,
      `UPDATE repositories
       SET status = ?, current_stage = ?, progress = COALESCE(?, progress), error_message = ?, commit_count = COALESCE(?, commit_count), updated_at = ?
       WHERE id = ?`,
      [status, stage, progress ?? null, errorMessage, commitCount ?? null, now(), id],
    );
  });
}

export async function updateRepositoryLocalPath(id: number, localPath: string): Promise<void> {
  await withDatabase((db) => {
    run(db, "UPDATE repositories SET local_path = ?, updated_at = ? WHERE id = ?", [localPath, now(), id]);
  });
}

export async function listAuthors(repositoryId: number): Promise<Author[]> {
  return withDatabase((db) =>
    all<AuthorRow>(
      db,
      `SELECT a.*, COUNT(c.sha) AS commit_count
       FROM authors a
       LEFT JOIN commits c ON c.repository_id = a.repository_id AND c.author_id = a.id
       WHERE a.repository_id = ?
       GROUP BY a.id
       ORDER BY a.display_name`,
      [repositoryId],
    ).map(toAuthor),
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

export async function mergeAuthors(repositoryId: number, targetAuthorId: number, sourceAuthorIds: number[]): Promise<Author[]> {
  const uniqueSources = [...new Set(sourceAuthorIds.filter((id) => id !== targetAuthorId))];
  if (uniqueSources.length === 0) return listAuthors(repositoryId);

  await withDatabase((db) => {
    const target = get<{ id: number }>(db, "SELECT id FROM authors WHERE repository_id = ? AND id = ?", [repositoryId, targetAuthorId]);
    if (!target) throw new Error("Target author does not exist in this repository");
    const placeholders = uniqueSources.map(() => "?").join(", ");
    const found = scalar(
      db,
      `SELECT COUNT(*) AS value FROM authors WHERE repository_id = ? AND id IN (${placeholders})`,
      [repositoryId, ...uniqueSources],
    );
    if (found !== uniqueSources.length) throw new Error("One or more source authors do not exist in this repository");

    transaction(db, () => {
      run(db, `UPDATE commits SET author_id = ? WHERE repository_id = ? AND author_id IN (${placeholders})`, [
        targetAuthorId,
        repositoryId,
        ...uniqueSources,
      ]);
      run(db, `DELETE FROM authors WHERE repository_id = ? AND id IN (${placeholders})`, [repositoryId, ...uniqueSources]);
    });
  });

  return listAuthors(repositoryId);
}

export async function createIngestJob(repositoryId: number): Promise<IngestJob> {
  return withDatabase((db) => {
    const timestamp = now();
    run(
      db,
      `INSERT INTO ingest_jobs (repository_id, status, stage, progress, message, error_message, created_at, updated_at, completed_at)
       VALUES (?, 'queued', 'queued', 0, 'Queued', NULL, ?, ?, NULL)`,
      [repositoryId, timestamp, timestamp],
    );
    const id = scalar(db, "SELECT last_insert_rowid() AS value");
    return getIngestJobByIdInDb(db, id)!;
  });
}

export async function getIngestJobById(id: number): Promise<IngestJob | null> {
  return withDatabase((db) => getIngestJobByIdInDb(db, id));
}

export function getIngestJobByIdInDb(db: Database, id: number): IngestJob | null {
  const row = get<JobRow>(db, "SELECT * FROM ingest_jobs WHERE id = ?", [id]);
  return row ? toJob(row) : null;
}

export async function updateIngestJob(
  id: number,
  status: JobStatus,
  stage: JobStage,
  progress: number,
  message: string,
  errorMessage: string | null = null,
): Promise<void> {
  await withDatabase((db) => {
    const completed = status === "done" || status === "failed" ? now() : null;
    run(
      db,
      `UPDATE ingest_jobs
       SET status = ?, stage = ?, progress = ?, message = ?, error_message = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
       WHERE id = ?`,
      [status, stage, Math.max(0, Math.min(100, Math.round(progress))), message, errorMessage, now(), completed, id],
    );
  });
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
        `INSERT INTO commits (repository_id, sha, parent_sha, author_id, raw_author_name, raw_author_email, committer_date, subject, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const commit of input.commits) {
          commitStmt.run([
            commit.repositoryId,
            commit.sha,
            commit.parentSha,
            commit.authorId,
            commit.rawAuthorName,
            commit.rawAuthorEmail,
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
        "UPDATE repositories SET status = 'ready', current_stage = 'done', progress = 100, error_message = NULL, commit_count = ?, updated_at = ? WHERE id = ?",
        [input.commits.length, now(), input.repositoryId],
      );
    });
  });
}
