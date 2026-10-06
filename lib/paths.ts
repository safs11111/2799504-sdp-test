import path from "node:path";

export function dataDir(): string {
  return process.env.RAT_DATA_DIR ?? path.join(process.cwd(), "data");
}

export function databasePath(): string {
  return process.env.RAT_DB_PATH ?? path.join(dataDir(), "rat.sqlite");
}

export function repositoriesDir(): string {
  return process.env.RAT_REPOS_DIR ?? path.join(dataDir(), "repositories");
}

export function normalizeRepoName(input: string): string {
  const trimmed = input.trim().replace(/\.git$/i, "");
  const last = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "repository";
  return last.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "repository";
}
