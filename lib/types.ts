export type RepoStatus = "pending" | "cloning" | "extracting" | "analyzing" | "indexing" | "ready" | "failed";
export type RepoSourceType = "url" | "path" | "zip";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobStage = "queued" | "cloning" | "extracting" | "parsing" | "indexing" | "done" | "failed";

export type Repository = {
  id: number;
  name: string;
  sourceType: RepoSourceType;
  source: string;
  localPath: string;
  status: RepoStatus;
  errorMessage: string | null;
  commitCount: number;
  progress: number;
  currentStage: string;
  createdAt: number;
  updatedAt: number;
};

export type IngestJob = {
  id: number;
  repositoryId: number;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  message: string;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type Author = {
  id: number;
  repositoryId: number;
  name: string;
  email: string;
  displayName: string;
  commitCount: number;
};

export type CommitRecord = {
  repositoryId: number;
  sha: string;
  parentSha: string | null;
  authorId: number;
  rawAuthorName: string;
  rawAuthorEmail: string;
  committerDate: number;
  subject: string;
  ordinal: number;
};

export type FileChange = {
  repositoryId: number;
  commitSha: string;
  path: string;
  added: number;
  removed: number;
};

export type DirMetric = {
  repositoryId: number;
  commitSha: string;
  dirPath: string;
  added: number;
  removed: number;
};

export type ObjectLifetime = {
  repositoryId: number;
  kind: ObjectKind;
  path: string;
  firstOrdinal: number;
  lastOrdinal: number;
};

export type MetricFilters = {
  authorId?: number;
  from?: number;
  to?: number;
  commits?: string[];
};

export type ObjectKind = "file" | "dir";
export type SortField = "path" | "added" | "removed" | "growth" | "churn" | "modifications" | "modificationFrequency" | "churnRate";
export type SortDirection = "asc" | "desc";

export type Pagination = {
  limit: number;
  offset: number;
  sortBy: SortField;
  sortDir: SortDirection;
};

export type MetricRow = {
  path: string;
  kind: ObjectKind;
  added: number;
  removed: number;
  growth: number;
  churn: number;
  modifications: number;
  modificationFrequency: number;
  churnRate: number;
};

export type AuthorMetricRow = {
  authorId: number;
  name: string;
  email: string;
  modifications: number;
  churn: number;
  ownership: number;
};

export type CommitListRow = {
  sha: string;
  authorId: number;
  authorName: string;
  authorEmail: string;
  committerDate: number;
  subject: string;
  ordinal: number;
};

export type MetricsResult = {
  denominatorCommits: number;
  summary: MetricRow;
  files: MetricRow[];
  directories: MetricRow[];
  authors: AuthorMetricRow[];
  fileTotal: number;
  directoryTotal: number;
  page: {
    limit: number;
    offset: number;
    sortBy: SortField;
    sortDir: SortDirection;
  };
};
