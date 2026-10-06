import { all, get, scalar, withDatabase } from "./db";
import type { AuthorMetricRow, CommitListRow, MetricFilters, MetricRow, MetricsResult, ObjectKind, Pagination, SortDirection, SortField } from "./types";

type AggregateRow = { path: string; added: number; removed: number; modifications: number };
type AuthorAggregateRow = { author_id: number; name: string; email: string; modifications: number; churn: number };

const sortExpressions: Record<SortField, string> = {
  path: "path",
  added: "added",
  removed: "removed",
  growth: "growth",
  churn: "churn",
  modifications: "modifications",
  modificationFrequency: "modificationFrequency",
  churnRate: "churnRate",
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

function subtreeCondition(column: string, dirPath: string): { sql: string; params: (string | number)[] } {
  if (!dirPath) return { sql: "1 = 1", params: [] };
  const prefix = `${dirPath}/`;
  return { sql: `(${column} = ? OR substr(${column}, 1, ?) = ?)`, params: [dirPath, prefix.length, prefix] };
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

function paginationFromUrl(url: URL): Pagination {
  const rawSort = url.searchParams.get("sortBy") as SortField | null;
  const rawDir = url.searchParams.get("sortDir") as SortDirection | null;
  return {
    limit: Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500),
    offset: Math.max(Number(url.searchParams.get("offset") ?? 0), 0),
    sortBy: rawSort && rawSort in sortExpressions ? rawSort : "churn",
    sortDir: rawDir === "asc" ? "asc" : "desc",
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

export function paginationFromRequest(requestUrl: string): Pagination {
  return paginationFromUrl(new URL(requestUrl));
}

function aggregateListSql(table: "changes" | "dir_metrics", pathColumn: "path" | "dir_path", kind: ObjectKind, repositoryId: number, filters: MetricFilters, basePath: string, pagination: Pagination) {
  const commitFilter = commitFilterSql(repositoryId, filters);
  const subtree = subtreeCondition(pathColumn, basePath);
  const sort = sortExpressions[pagination.sortBy];
  const direction = pagination.sortDir.toUpperCase();
  const denominatorSql = `CASE WHEN ? = 0 THEN 0.0 ELSE CAST(COALESCE(agg.modifications, 0) AS REAL) / ? END`;
  const churnRateSql = `CASE WHEN ? = 0 THEN 0.0 ELSE CAST((COALESCE(agg.added, 0) + COALESCE(agg.removed, 0)) AS REAL) / ? END`;

  return {
    sql: `WITH base AS (
            SELECT DISTINCT ${pathColumn} AS path
            FROM ${table}
            WHERE repository_id = ? AND ${subtree.sql}
          ), agg AS (
            SELECT m.${pathColumn} AS path,
                   COALESCE(SUM(m.added), 0) AS added,
                   COALESCE(SUM(m.removed), 0) AS removed,
                   COALESCE(SUM(CASE WHEN (m.added + m.removed) > 0 THEN 1 ELSE 0 END), 0) AS modifications
            FROM ${table} m
            JOIN commits c ON c.repository_id = m.repository_id AND c.sha = m.commit_sha
            WHERE ${commitFilter.where} AND ${subtreeCondition(`m.${pathColumn}`, basePath).sql}
            GROUP BY m.${pathColumn}
          )
          SELECT base.path AS path,
                 COALESCE(agg.added, 0) AS added,
                 COALESCE(agg.removed, 0) AS removed,
                 (COALESCE(agg.added, 0) - COALESCE(agg.removed, 0)) AS growth,
                 (COALESCE(agg.added, 0) + COALESCE(agg.removed, 0)) AS churn,
                 COALESCE(agg.modifications, 0) AS modifications,
                 ${denominatorSql} AS modificationFrequency,
                 ${churnRateSql} AS churnRate
          FROM base
          LEFT JOIN agg ON agg.path = base.path
          ORDER BY ${sort} ${direction}, path ASC
          LIMIT ? OFFSET ?`,
    params: [repositoryId, ...subtree.params, ...commitFilter.params, ...subtreeCondition(`m.${pathColumn}`, basePath).params, 0, 0, 0, 0, pagination.limit, pagination.offset],
    kind,
  };
}

export async function getRepositoryMetrics(
  repositoryId: number,
  filters: MetricFilters = {},
  objectPath = "",
  kind: ObjectKind = "dir",
  pagination: Pagination = { limit: 50, offset: 0, sortBy: "churn", sortDir: "desc" },
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
    const summary = metricRow(objectPath, kind, Number(summaryRow?.added ?? 0), Number(summaryRow?.removed ?? 0), Number(summaryRow?.modifications ?? 0), denominatorCommits);

    const fileSubtree = kind === "file" ? subtreeCondition("path", objectPath) : subtreeCondition("path", objectPath);
    const dirSubtree = kind === "file" ? subtreeCondition("dir_path", "") : subtreeCondition("dir_path", objectPath);
    const fileTotal = scalar(db, `SELECT COUNT(DISTINCT path) AS value FROM changes WHERE repository_id = ? AND ${fileSubtree.sql}`, [repositoryId, ...fileSubtree.params]);
    const directoryTotal = scalar(db, `SELECT COUNT(DISTINCT dir_path) AS value FROM dir_metrics WHERE repository_id = ? AND ${dirSubtree.sql}`, [repositoryId, ...dirSubtree.params]);

    const filesQuery = aggregateListSql("changes", "path", "file", repositoryId, filters, kind === "file" ? objectPath : objectPath, pagination);
    filesQuery.params[filesQuery.params.length - 6] = denominatorCommits;
    filesQuery.params[filesQuery.params.length - 5] = denominatorCommits;
    filesQuery.params[filesQuery.params.length - 4] = denominatorCommits;
    filesQuery.params[filesQuery.params.length - 3] = denominatorCommits;
    const files = all<AggregateRow>(db, filesQuery.sql, filesQuery.params).map((row) => metricRow(row.path, "file", Number(row.added), Number(row.removed), Number(row.modifications), denominatorCommits));

    const dirsQuery = aggregateListSql("dir_metrics", "dir_path", "dir", repositoryId, filters, kind === "file" ? "" : objectPath, pagination);
    dirsQuery.params[dirsQuery.params.length - 6] = denominatorCommits;
    dirsQuery.params[dirsQuery.params.length - 5] = denominatorCommits;
    dirsQuery.params[dirsQuery.params.length - 4] = denominatorCommits;
    dirsQuery.params[dirsQuery.params.length - 3] = denominatorCommits;
    const directories = all<AggregateRow>(db, dirsQuery.sql, dirsQuery.params).map((row) => metricRow(row.path, "dir", Number(row.added), Number(row.removed), Number(row.modifications), denominatorCommits));

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

    return { denominatorCommits, summary, files, directories, authors, fileTotal, directoryTotal, page: pagination };
  });
}

export async function listCommits(repositoryId: number, filters: MetricFilters = {}, limit = 250, offset = 0, objectPath = "", kind: ObjectKind = "dir"): Promise<CommitListRow[]> {
  return withDatabase((db) => {
    const commitFilter = commitFilterSql(repositoryId, filters);
    const pathJoin = objectPath
      ? kind === "file"
        ? "JOIN changes m ON m.repository_id = c.repository_id AND m.commit_sha = c.sha AND m.path = ?"
        : "JOIN dir_metrics m ON m.repository_id = c.repository_id AND m.commit_sha = c.sha AND m.dir_path = ?"
      : "";
    const rows = all<{ sha: string; author_id: number; name: string; email: string; committer_date: number; subject: string; ordinal: number }>(
      db,
      `SELECT DISTINCT c.sha, c.author_id, a.name, a.email, c.committer_date, c.subject, c.ordinal
       FROM commits c
       JOIN authors a ON a.id = c.author_id
       ${pathJoin}
       WHERE ${commitFilter.where}
       ORDER BY c.ordinal DESC
       LIMIT ? OFFSET ?`,
      [...(objectPath ? [objectPath] : []), ...commitFilter.params, limit, offset],
    );
    return rows.map((row) => ({
      sha: row.sha,
      authorId: Number(row.author_id),
      authorName: row.name,
      authorEmail: row.email,
      committerDate: Number(row.committer_date),
      subject: row.subject,
      ordinal: Number(row.ordinal),
    }));
  });
}
