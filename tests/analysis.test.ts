import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempRoot = "";

function sh(args: string[], cwd: string, env: Record<string, string> = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function writeFile(repo: string, relativePath: string, contents: string | Buffer) {
  const fullPath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function gitDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

function commit(repo: string, message: string, authorName: string, authorEmail: string, timestamp: number) {
  sh(["git", "add", "."], repo);
  sh(
    ["git", "commit", "-m", message, `--author=${authorName} <${authorEmail}>`],
    repo,
    {
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
      GIT_COMMITTER_DATE: gitDate(timestamp),
      GIT_AUTHOR_DATE: gitDate(timestamp),
    },
  );
}

function createFixtureRepo(): string {
  const repo = path.join(tempRoot, "fixture");
  fs.mkdirSync(repo, { recursive: true });
  sh(["git", "init"], repo);
  sh(["git", "config", "user.name", "Test User"], repo);
  sh(["git", "config", "user.email", "test@example.com"], repo);

  writeFile(repo, ".mailmap", "Alice <alice@example.com> Alice Alias <alias@example.com>\n");
  writeFile(repo, "src/a.txt", "one\ntwo\n");
  commit(repo, "initial", "Alice Alias", "alias@example.com", 1000);

  writeFile(repo, "src/a.txt", "one\ntwo\nthree\n");
  commit(repo, "append line", "Bob", "bob@example.com", 2000);

  sh(["git", "mv", "src/a.txt", "src/renamed.txt"], repo);
  commit(repo, "pure rename", "Alice", "alice@example.com", 3000);

  writeFile(repo, "src/renamed.txt", "ONE\ntwo\nthree\n");
  commit(repo, "edit renamed", "Alice", "alice@example.com", 4000);

  fs.rmSync(path.join(repo, "src/renamed.txt"));
  commit(repo, "delete renamed", "Bob", "bob@example.com", 5000);

  writeFile(repo, "bin.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
  commit(repo, "binary ignored", "Bob", "bob@example.com", 6000);

  sh(["git", "checkout", "-b", "feature"], repo);
  writeFile(repo, "feature.txt", "feature\n");
  commit(repo, "feature file", "Alice", "alice@example.com", 7000);

  sh(["git", "checkout", "master"], repo);
  writeFile(repo, "main.txt", "main\n");
  commit(repo, "main file", "Bob", "bob@example.com", 8000);
  sh(["git", "merge", "--no-ff", "feature", "-m", "merge feature"], repo, {
    GIT_COMMITTER_NAME: "Bob",
    GIT_COMMITTER_EMAIL: "bob@example.com",
    GIT_COMMITTER_DATE: gitDate(9000),
  });

  return repo;
}

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rat-test-"));
  process.env.RAT_DATA_DIR = path.join(tempRoot, "data");
  process.env.RAT_DB_PATH = path.join(tempRoot, "data", "rat.sqlite");
  process.env.RAT_REPOS_DIR = path.join(tempRoot, "data", "repositories");
  const { resetDatabaseConnectionForTests } = await import("../lib/db");
  resetDatabaseConnectionForTests();
});

afterEach(async () => {
  const { resetDatabaseConnectionForTests } = await import("../lib/db");
  resetDatabaseConnectionForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("repository analysis foundation", () => {
  it("persists non-merge commits, authors, file metrics, directory rollups, and binary skips", async () => {
    const repo = createFixtureRepo();
    const { createRepository, listAuthors, getRepositoryById } = await import("../lib/repositories");
    const { analyzeRepository } = await import("../lib/git");
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const record = await createRepository({ name: "fixture", sourceType: "path", source: repo, localPath: repo });
    await analyzeRepository(record.id, repo);

    const stored = await getRepositoryById(record.id);
    const expectedNonMergeCount = Number(sh(["git", "rev-list", "--count", "--no-merges", "HEAD"], repo).trim());
    expect(stored?.status).toBe("ready");
    expect(stored?.commitCount).toBe(expectedNonMergeCount);

    const root = await getRepositoryMetrics(record.id);
    const src = await getRepositoryMetrics(record.id, {}, "src", "dir");
    const oldFile = await getRepositoryMetrics(record.id, {}, "src/a.txt", "file");
    const renamedFile = await getRepositoryMetrics(record.id, {}, "src/renamed.txt", "file");
    const binary = await getRepositoryMetrics(record.id, {}, "bin.dat", "file");

    expect(root.denominatorCommits).toBe(expectedNonMergeCount);
    expect(src.summary.added).toBe(4);
    expect(src.summary.removed).toBe(4);
    expect(src.summary.churn).toBe(8);
    expect(oldFile.summary.added).toBe(3);
    expect(oldFile.summary.removed).toBe(0);
    expect(renamedFile.summary.added).toBe(1);
    expect(renamedFile.summary.removed).toBe(4);
    expect(binary.summary.churn).toBe(0);

    const authors = await listAuthors(record.id);
    expect(authors.some((author) => author.name === "Alice" && author.email === "alice@example.com")).toBe(true);
    expect(authors.some((author) => author.email === "alias@example.com")).toBe(false);
  });

  it("applies author and committer-date commit-set filters with safe zero denominators", async () => {
    const repo = createFixtureRepo();
    const { createRepository, listAuthors } = await import("../lib/repositories");
    const { analyzeRepository } = await import("../lib/git");
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const record = await createRepository({ name: "fixture", sourceType: "path", source: repo, localPath: repo });
    await analyzeRepository(record.id, repo);
    const authors = await listAuthors(record.id);
    const bob = authors.find((author) => author.email === "bob@example.com");
    expect(bob).toBeDefined();

    const onlyBobOnSrc = await getRepositoryMetrics(record.id, { authorId: bob!.id }, "src", "dir");
    expect(onlyBobOnSrc.denominatorCommits).toBeGreaterThan(0);
    expect(onlyBobOnSrc.summary.added).toBe(1);
    expect(onlyBobOnSrc.summary.removed).toBe(3);
    expect(onlyBobOnSrc.summary.churn).toBe(4);

    const exactWindow = await getRepositoryMetrics(record.id, { from: 4000, to: 5000 }, "src", "dir");
    expect(exactWindow.denominatorCommits).toBe(1);
    expect(exactWindow.summary.added).toBe(1);
    expect(exactWindow.summary.removed).toBe(1);

    const empty = await getRepositoryMetrics(record.id, { from: 999999 }, "src", "dir");
    expect(empty.denominatorCommits).toBe(0);
    expect(empty.summary.modificationFrequency).toBe(0);
    expect(empty.summary.churnRate).toBe(0);
  });
});
