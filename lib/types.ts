export type RepoStatus = "pending" | "analyzing" | "ready" | "failed";
export type RepoSourceType = "url" | "path";

export type Repository = {
  id: number;
  name: string;
  sourceType: RepoSourceType;
  source: string;
  localPath: string;
  status: RepoStatus;
  errorMessage: string | null;
  commitCount: number;
  createdAt: number;
  updatedAt: number;
};

export type Author = {
  id: number;
  repositoryId: number;
  name: string;
  email: string;
  displayName: string;
};

export type CommitRecord = {
  repositoryId: number;
  sha: string;
  parentSha: string | null;
  authorId: number;
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

export type MetricFilters = {
  authorId?: number;
  from?: number;
  to?: number;
  commits?: string[];
};

export type ObjectKind = "file" | "dir";

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

export type MetricsResult = {
  denominatorCommits: number;
  summary: MetricRow;
  files: MetricRow[];
  directories: MetricRow[];
  authors: AuthorMetricRow[];
};
