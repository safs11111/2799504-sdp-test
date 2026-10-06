import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, transaction } from "./db";
import { repositoriesDir } from "./paths";
import { findOrCreateAuthor, replaceRepositoryAnalysis, updateRepositoryProgress, updateRepositoryStatus } from "./repositories";
import type { CommitRecord, DirMetric, FileChange, JobStage, ObjectKind, ObjectLifetime } from "./types";

const execFileAsync = promisify(execFile);

type ParsedCommit = {
  sha: string;
  parentSha: string | null;
  authorName: string;
  authorEmail: string;
  rawAuthorName: string;
  rawAuthorEmail: string;
  committerDate: number;
  subject: string;
  changes: ParsedChange[];
};

type ParsedChange = {
  path: string;
  added: number;
  removed: number;
};

export type AnalysisProgress = (stage: JobStage, progress: number, message: string) => Promise<void> | void;

// git operations must stay async: the server handles UI polling on the same
// event loop, so a synchronous clone/log would freeze every request (the
// dashboard then sits at "cloning 5%" forever).
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return stdout;
}

export async function ensureGitAvailable(): Promise<void> {
  try {
    await git(["--version"]);
  } catch {
    throw new Error("git is not installed or is not available on PATH");
  }
}

export async function ensureGitRepository(repoPath: string): Promise<void> {
  await ensureGitAvailable();
  if (!fs.existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
  const inside = (await git(["rev-parse", "--is-inside-work-tree"], repoPath)).trim();
  if (inside !== "true") throw new Error(`Path is not a git work tree: ${repoPath}`);
  const gitPath = path.join(repoPath, ".git");
  if (!fs.existsSync(gitPath)) throw new Error(`Repository must include a .git file or directory: ${repoPath}`);
}

export async function cloneRepository(url: string, repositoryId: number): Promise<string> {
  await ensureGitAvailable();
  fs.mkdirSync(repositoriesDir(), { recursive: true });
  const target = path.join(repositoriesDir(), String(repositoryId));
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  await git(["clone", "--", url, target]);
  return target;
}

function consumeHeader(record: string): { commit: Omit<ParsedCommit, "changes">; body: string } | null {
  const newline = record.indexOf("\n");
  const header = (newline === -1 ? record : record.slice(0, newline)).replace(/^\n+/, "").trimStart();
  const body = newline === -1 ? "" : record.slice(newline + 1);
  const parts = header.split("\x00");
  if (parts.length < 8 || !parts[0]) return null;
  const [sha, parents, authorName, authorEmail, rawAuthorName, rawAuthorEmail, timestamp, ...subjectParts] = parts;
  return {
    commit: {
      sha: sha.trim(),
      parentSha: parents.split(" ").filter(Boolean)[0] ?? null,
      authorName: authorName || "Unknown",
      authorEmail: authorEmail || "",
      rawAuthorName: rawAuthorName || authorName || "Unknown",
      rawAuthorEmail: rawAuthorEmail || authorEmail || "",
      committerDate: Number(timestamp),
      subject: subjectParts.join("\x00"),
    },
    body,
  };
}

function parseNumstatBody(body: string): ParsedChange[] {
  const tokens = body.split("\x00").map((token) => token.replace(/^\n+/, "")).filter((token) => token.length > 0);
  const changes: ParsedChange[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, pathPart] = parts;
    const isRename = pathPart === "";

    if (addedRaw === "-" || removedRaw === "-") {
      if (isRename) index += 2;
      continue;
    }

    const added = Number(addedRaw);
    const removed = Number(removedRaw);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) {
      if (isRename) index += 2;
      continue;
    }

    let changedPath = pathPart;
    if (isRename) {
      index += 2;
      changedPath = tokens[index] ?? "";
    }
    if (changedPath) changes.push({ path: changedPath, added, removed });
  }

  return changes;
}

export async function parseGitLogNumstat(repoPath: string): Promise<ParsedCommit[]> {
  const output = await git(
    [
      "log",
      "--no-merges",
      "--reverse",
      "--numstat",
      "-z",
      "-M50%",
      "--root",
      "--format=%x1e%H%x00%P%x00%aN%x00%aE%x00%an%x00%ae%x00%ct%x00%s",
      "HEAD",
    ],
    repoPath,
  );

  return output
    .split("\x1e")
    .map((record) => record.trimStart())
    .filter(Boolean)
    .map((record) => {
      const parsed = consumeHeader(record);
      if (!parsed) return null;
      return { ...parsed.commit, changes: parseNumstatBody(parsed.body) };
    })
    .filter((commit): commit is ParsedCommit => commit !== null);
}

export function ancestorDirectories(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  const dirs = [""];
  for (let length = 1; length < parts.length; length += 1) {
    dirs.push(parts.slice(0, length).join("/"));
  }
  return dirs;
}

function touchLifetime(
  lifetimes: Map<string, { kind: ObjectKind; path: string; firstOrdinal: number; lastOrdinal: number }>,
  kind: ObjectKind,
  itemPath: string,
  ordinal: number,
): void {
  const key = `${kind}\x00${itemPath}`;
  const current = lifetimes.get(key);
  if (!current) lifetimes.set(key, { kind, path: itemPath, firstOrdinal: ordinal, lastOrdinal: ordinal });
  else current.lastOrdinal = ordinal;
}

function rollUpDirectories(repositoryId: number, commitSha: string, changes: FileChange[]): DirMetric[] {
  const byDir = new Map<string, { added: number; removed: number }>();
  for (const change of changes) {
    for (const dir of ancestorDirectories(change.path)) {
      const current = byDir.get(dir) ?? { added: 0, removed: 0 };
      current.added += change.added;
      current.removed += change.removed;
      byDir.set(dir, current);
    }
  }

  return [...byDir.entries()].map(([dirPath, totals]) => ({
    repositoryId,
    commitSha,
    dirPath,
    added: totals.added,
    removed: totals.removed,
  }));
}

export async function analyzeRepository(repositoryId: number, repoPath: string, onProgress?: AnalysisProgress): Promise<void> {
  await updateRepositoryStatus(repositoryId, "analyzing");
  try {
    await ensureGitRepository(repoPath);
    await onProgress?.("parsing", 20, "Reading git history");
    const parsedCommits = await parseGitLogNumstat(repoPath);
    const db = await openDatabase();
    const authorByIdentity = new Map<string, number>();
    const commits: CommitRecord[] = [];
    const changes: FileChange[] = [];
    const dirMetrics: DirMetric[] = [];
    const lifetimes = new Map<string, { kind: ObjectKind; path: string; firstOrdinal: number; lastOrdinal: number }>();

    transaction(db, () => {
      for (const parsed of parsedCommits) {
        const key = `${parsed.authorName}\x00${parsed.authorEmail}`;
        if (!authorByIdentity.has(key)) {
          authorByIdentity.set(key, findOrCreateAuthor(db, repositoryId, parsed.authorName, parsed.authorEmail));
        }
      }
    });

    for (let ordinal = 0; ordinal < parsedCommits.length; ordinal += 1) {
      const parsed = parsedCommits[ordinal];
      const authorId = authorByIdentity.get(`${parsed.authorName}\x00${parsed.authorEmail}`)!;
      commits.push({
        repositoryId,
        sha: parsed.sha,
        parentSha: parsed.parentSha,
        authorId,
        rawAuthorName: parsed.rawAuthorName,
        rawAuthorEmail: parsed.rawAuthorEmail,
        committerDate: parsed.committerDate,
        subject: parsed.subject,
        ordinal,
      });

      const commitChanges = parsed.changes.map((change) => ({
        repositoryId,
        commitSha: parsed.sha,
        path: change.path,
        added: change.added,
        removed: change.removed,
      }));
      for (const change of commitChanges) {
        touchLifetime(lifetimes, "file", change.path, ordinal);
        for (const dir of ancestorDirectories(change.path)) touchLifetime(lifetimes, "dir", dir, ordinal);
      }
      changes.push(...commitChanges);
      dirMetrics.push(...rollUpDirectories(repositoryId, parsed.sha, commitChanges));

      if (ordinal % 100 === 0 || ordinal === parsedCommits.length - 1) {
        const progress = 20 + Math.round(((ordinal + 1) / Math.max(parsedCommits.length, 1)) * 60);
        await onProgress?.("parsing", progress, `Parsed ${ordinal + 1} of ${parsedCommits.length} commits`);
        await updateRepositoryProgress(repositoryId, "analyzing", "parsing", progress);
      }
    }

    const objectLifetimes: ObjectLifetime[] = [...lifetimes.values()].map((item) => ({
      repositoryId,
      kind: item.kind,
      path: item.path,
      firstOrdinal: item.firstOrdinal,
      lastOrdinal: item.lastOrdinal,
    }));

    await onProgress?.("indexing", 85, "Persisting metric indexes");
    await updateRepositoryProgress(repositoryId, "indexing", "indexing", 85);
    await replaceRepositoryAnalysis({ repositoryId, commits, changes, dirMetrics, objectLifetimes });
    await onProgress?.("done", 100, "Analysis complete");
  } catch (error) {
    await updateRepositoryStatus(repositoryId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
