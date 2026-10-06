import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, transaction } from "./db";
import { repositoriesDir } from "./paths";
import { findOrCreateAuthor, replaceRepositoryAnalysis, updateRepositoryStatus } from "./repositories";
import type { CommitRecord, DirMetric, FileChange } from "./types";

type ParsedCommit = {
  sha: string;
  parentSha: string | null;
  authorName: string;
  authorEmail: string;
  committerDate: number;
  subject: string;
};

type ParsedChange = {
  path: string;
  added: number;
  removed: number;
};

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function ensureGitRepository(repoPath: string): void {
  if (!fs.existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
  const inside = git(["rev-parse", "--is-inside-work-tree"], repoPath).trim();
  if (inside !== "true") throw new Error(`Path is not a git work tree: ${repoPath}`);
}

export function cloneRepository(url: string, repositoryId: number): string {
  fs.mkdirSync(repositoriesDir(), { recursive: true });
  const target = path.join(repositoriesDir(), String(repositoryId));
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  git(["clone", "--", url, target]);
  return target;
}

function parseCommits(repoPath: string): ParsedCommit[] {
  const output = git(["log", "--no-merges", "--reverse", "--format=%H%x00%P%x00%aN%x00%aE%x00%ct%x00%s%x1e", "HEAD"], repoPath);
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, parents, authorName, authorEmail, ts, ...subjectParts] = entry.split("\x00");
      return {
        sha,
        parentSha: parents.split(" ").filter(Boolean)[0] ?? null,
        authorName: authorName || "Unknown",
        authorEmail: authorEmail || "",
        committerDate: Number(ts),
        subject: subjectParts.join("\x00"),
      };
    });
}

function parseNumstat(repoPath: string, sha: string): ParsedChange[] {
  const output = execFileSync("git", ["diff-tree", "--root", "--no-commit-id", "-r", "-M50%", "--numstat", "-z", sha], {
    cwd: repoPath,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 256,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

  const tokens = output.split("\x00").filter((token) => token.length > 0);
  const changes: ParsedChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, pathPart] = parts;
    if (addedRaw === "-" || removedRaw === "-") {
      if (pathPart === "") index += 2;
      continue;
    }

    const added = Number(addedRaw);
    const removed = Number(removedRaw);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;

    let changedPath = pathPart;
    if (pathPart === "") {
      index += 2;
      changedPath = tokens[index] ?? "";
    }
    if (!changedPath) continue;
    changes.push({ path: changedPath, added, removed });
  }
  return changes;
}

export function ancestorDirectories(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  const dirs = [""];
  for (let length = 1; length < parts.length; length += 1) {
    dirs.push(parts.slice(0, length).join("/"));
  }
  return dirs;
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

export async function analyzeRepository(repositoryId: number, repoPath: string): Promise<void> {
  await updateRepositoryStatus(repositoryId, "analyzing");
  try {
    ensureGitRepository(repoPath);
    const parsedCommits = parseCommits(repoPath);
    const db = await openDatabase();
    const authorByIdentity = new Map<string, number>();
    const commits: CommitRecord[] = [];
    const changes: FileChange[] = [];
    const dirMetrics: DirMetric[] = [];

    transaction(db, () => {
      for (const parsed of parsedCommits) {
        const key = `${parsed.authorName}\x00${parsed.authorEmail}`;
        if (!authorByIdentity.has(key)) {
          authorByIdentity.set(key, findOrCreateAuthor(db, repositoryId, parsed.authorName, parsed.authorEmail));
        }
      }
    });

    parsedCommits.forEach((parsed, ordinal) => {
      const authorId = authorByIdentity.get(`${parsed.authorName}\x00${parsed.authorEmail}`)!;
      commits.push({
        repositoryId,
        sha: parsed.sha,
        parentSha: parsed.parentSha,
        authorId,
        committerDate: parsed.committerDate,
        subject: parsed.subject,
        ordinal,
      });

      const commitChanges = parseNumstat(repoPath, parsed.sha).map((change) => ({
        repositoryId,
        commitSha: parsed.sha,
        path: change.path,
        added: change.added,
        removed: change.removed,
      }));
      changes.push(...commitChanges);
      dirMetrics.push(...rollUpDirectories(repositoryId, parsed.sha, commitChanges));
    });

    await replaceRepositoryAnalysis({ repositoryId, commits, changes, dirMetrics });
  } catch (error) {
    await updateRepositoryStatus(repositoryId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
