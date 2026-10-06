import { all, get, scalar, withDatabase } from "./db";
import type { AuthorMetricRow, MetricFilters, MetricRow, MetricsResult, ObjectKind } from "./types";

type AggregateRow = {
  path: string;
  added: number;
  removed: number;
  modifications: number;
};

type AuthorAggregateRow = {
  author_id: number;
  name: string;
  email: string;
  modifications: number;
  churn: number;
};

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function commitFilterSql(repositoryId: number, filters: MetricFilters): { where: string; params: (string | number)[] } {
  const clauses = ["c.repository_id = ?"];
  const params: (string | number)[] = [repositoryId];

  if (filters.authorId !== undefined) {
    clauses.push("c.author_id = ?");
    params.push(filters.authorId);
  }
  if (filters.from !== undefined) {
    clauses.push("c.committer_date >= ?");
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    clauses.push("c.committer_date < ?");
    params.push(filters.to);
  }
  if (filters.commits && filters.commits.length > 0) {
    clauses.push(`c.sha IN (${placeholders(filters.commits.length)})`);
    params.push(...filters.commits);
  }

  return { where: clauses.join(" AND "), params };
}

function metricRow(path: string, kind: ObjectKind, added: number, removed: number, modifications: number, denominator: number): MetricRow {
  const churn = added + removed;
  return {
    path,
    kind,
    added,
    removed,
    growth: added - removed,
    churn,
    modifications,
    modificationFrequency: denominator === 0 ? 0 : modifications / denominator,
    churnRate: denominator === 0 ? 0 : churn / denominator,
  };
}

function parseFilters(url: URL): MetricFilters {
  const filters: MetricFilters = {};
  const authorId = url.searchParams.get("authorId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const commits = url.searchParams.get("commits");
  if (authorId) filters.authorId = Number(authorId);
  if (from) filters.from = Number(from);
  if (to) filters.to = Number(to);
  if (commits) filters.commits = commits.split(",").map((sha) => sha.trim()).filter(Boolean);
  return filters;
}

export function metricFiltersFromRequest(requestUrl: string): MetricFilters {
  return parseFilters(new URL(requestUrl));
}

export async function getRepositoryMetrics(
  repositoryId: number,
  filters: MetricFilters = {},
  objectPath = "",
  kind: ObjectKind = "dir",
): Promise<MetricsResult> {
  return withDatabase((db) => {
    const commitFilter = commitFilterSql(repositoryId, filters);
    const denominatorCommits = scalar(db, `SELECT COUNT(*) AS value FROM commits c WHERE ${commitFilter.where}`, commitFilter.params);

    const sourceTable = kind === "file" ? "changes" : "dir_metrics";
    const pathColumn = kind === "file" ? "path" : "dir_path";
    const summaryRow = get<AggregateRow>(
      db,
      `SELECT ? AS path,
              COALESCE(SUM(m.added), 0) AS added,
              COALESCE(SUM(m.removed), 0) AS removed,
              COALESCE(SUM(CASE WHEN (m.added + m.removed) > 0 THEN 1 ELSE 0 END), 0) AS modifications
       FROM ${sourceTable} m
       JOIN commits c ON c.repository_id = m.repository_id AND c.sha = m.commit_sha
       WHERE ${commitFilter.where} AND m.${pathColumn} = ?`,
      [objectPath, ...commitFilter.params, objectPath],
    );
    const summary = metricRow(
      objectPath,
      kind,
      Number(summaryRow?.added ?? 0),
      Number(summaryRow?.removed ?? 0),
      Number(summaryRow?.modifications ?? 0),
      denominatorCommits,
    );

    const fileRows = all<AggregateRow>(
      db,
      `SELECT m.path AS path,
              COALESCE(SUM(m.added), 0) AS added,
              COALESCE(SUM(m.removed), 0) AS removed,
              COALESCE(SUM(CASE WHEN (m.added + m.removed) > 0 THEN 1 ELSE 0 END), 0) AS modifications
       FROM changes m
       JOIN commits c ON c.repository_id = m.repository_id AND c.sha = m.commit_sha
       WHERE ${commitFilter.where}
       GROUP BY m.path
       ORDER BY (COALESCE(SUM(m.added), 0) + COALESCE(SUM(m.removed), 0)) DESC, m.path ASC
       LIMIT 100`,
      commitFilter.params,
    ).map((row) => metricRow(row.path, "file", Number(row.added), Number(row.removed), Number(row.modifications), denominatorCommits));

    const dirRows = all<AggregateRow>(
      db,
      `SELECT m.dir_path AS path,
              COALESCE(SUM(m.added), 0) AS added,
              COALESCE(SUM(m.removed), 0) AS removed,
              COALESCE(SUM(CASE WHEN (m.added + m.removed) > 0 THEN 1 ELSE 0 END), 0) AS modifications
       FROM dir_metrics m
       JOIN commits c ON c.repository_id = m.repository_id AND c.sha = m.commit_sha
       WHERE ${commitFilter.where}
       GROUP BY m.dir_path
       ORDER BY (COALESCE(SUM(m.added), 0) + COALESCE(SUM(m.removed), 0)) DESC, m.dir_path ASC
       LIMIT 100`,
      commitFilter.params,
    ).map((row) => metricRow(row.path, "dir", Number(row.added), Number(row.removed), Number(row.modifications), denominatorCommits));

    const authorRows = all<AuthorAggregateRow>(
      db,
      `SELECT a.id AS author_id,
              a.name AS name,
              a.email AS email,
              COALESCE(SUM(CASE WHEN (m.added + m.removed) > 0 THEN 1 ELSE 0 END), 0) AS modifications,
              COALESCE(SUM(m.added + m.removed), 0) AS churn
       FROM ${sourceTable} m
       JOIN commits c ON c.repository_id = m.repository_id AND c.sha = m.commit_sha
       JOIN authors a ON a.id = c.author_id
       WHERE ${commitFilter.where} AND m.${pathColumn} = ?
       GROUP BY a.id, a.name, a.email
       ORDER BY churn DESC, a.name ASC`,
      [...commitFilter.params, objectPath],
    );

    const authors: AuthorMetricRow[] = authorRows.map((row) => ({
      authorId: Number(row.author_id),
      name: row.name,
      email: row.email,
      modifications: Number(row.modifications),
      churn: Number(row.churn),
      ownership: summary.churn === 0 ? 0 : Number(row.churn) / summary.churn,
    }));

    return { denominatorCommits, summary, files: fileRows, directories: dirRows, authors };
  });
}

export async function listCommits(repositoryId: number, limit = 250): Promise<
  { sha: string; authorId: number; committerDate: number; subject: string; ordinal: number }[]
> {
  return withDatabase((db) =>
    all<{ sha: string; author_id: number; committer_date: number; subject: string; ordinal: number }>(
      db,
      `SELECT sha, author_id, committer_date, subject, ordinal
       FROM commits
       WHERE repository_id = ?
       ORDER BY ordinal DESC
       LIMIT ?`,
      [repositoryId, limit],
    ).map((row) => ({
      sha: row.sha,
      authorId: Number(row.author_id),
      committerDate: Number(row.committer_date),
      subject: row.subject,
      ordinal: Number(row.ordinal),
    })),
  );
}
