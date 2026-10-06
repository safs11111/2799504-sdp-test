import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
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
  sh(["git", "commit", "-m", message, `--author=${authorName} <${authorEmail}>`], repo, {
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_DATE: gitDate(timestamp),
    GIT_AUTHOR_DATE: gitDate(timestamp),
  });
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

async function analyzeFixture(repo: string) {
  const { createRepository } = await import("../lib/repositories");
  const { analyzeRepository } = await import("../lib/git");
  const record = await createRepository({ name: "fixture", sourceType: "path", source: repo, localPath: repo });
  await analyzeRepository(record.id, repo);
  return record;
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
    const record = await analyzeFixture(repo);
    const { listAuthors, getRepositoryById } = await import("../lib/repositories");
    const { getRepositoryMetrics } = await import("../lib/metrics");

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

  it("applies author, committer-date, and manual commit-set filters with safe zero denominators", async () => {
    const repo = createFixtureRepo();
    const record = await analyzeFixture(repo);
    const { listAuthors } = await import("../lib/repositories");
    const { getRepositoryMetrics, listCommits } = await import("../lib/metrics");

    const authors = await listAuthors(record.id);
    const bob = authors.find((author) => author.email === "bob@example.com");
    expect(bob).toBeDefined();

    const onlyBobOnSrc = await getRepositoryMetrics(record.id, { authorId: bob!.id }, "src", "dir");
    expect(onlyBobOnSrc.summary.added).toBe(1);
    expect(onlyBobOnSrc.summary.removed).toBe(3);
    expect(onlyBobOnSrc.summary.churn).toBe(4);

    const exactWindow = await getRepositoryMetrics(record.id, { from: 4000, to: 5000 }, "src", "dir");
    expect(exactWindow.denominatorCommits).toBe(1);
    expect(exactWindow.summary.added).toBe(1);
    expect(exactWindow.summary.removed).toBe(1);

    const commits = await listCommits(record.id, {}, 20);
    const deleteCommit = commits.find((commit) => commit.subject === "delete renamed");
    expect(deleteCommit).toBeDefined();
    const manual = await getRepositoryMetrics(record.id, { commits: [deleteCommit!.sha] }, "src", "dir");
    expect(manual.denominatorCommits).toBe(1);
    expect(manual.summary.added).toBe(0);
    expect(manual.summary.removed).toBe(3);

    const empty = await getRepositoryMetrics(record.id, { from: 999999 }, "src", "dir");
    expect(empty.denominatorCommits).toBe(0);
    expect(empty.summary.modificationFrequency).toBe(0);
    expect(empty.summary.churnRate).toBe(0);
  });

  it("keeps zero-metric historical objects visible in paginated tables", async () => {
    const repo = createFixtureRepo();
    const record = await analyzeFixture(repo);
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const metrics = await getRepositoryMetrics(record.id, { from: 7000, to: 8000 }, "", "dir", {
      limit: 100,
      offset: 0,
      sortBy: "path",
      sortDir: "asc",
    });
    const oldPath = metrics.files.find((file) => file.path === "src/a.txt");
    expect(oldPath).toBeDefined();
    expect(oldPath?.churn).toBe(0);
  });

  it("merges authors manually and recomputes ownership from commit author ids", async () => {
    const repo = createFixtureRepo();
    const record = await analyzeFixture(repo);
    const { listAuthors, mergeAuthors } = await import("../lib/repositories");
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const authors = await listAuthors(record.id);
    const alice = authors.find((author) => author.email === "alice@example.com")!;
    const bob = authors.find((author) => author.email === "bob@example.com")!;
    await mergeAuthors(record.id, alice.id, [bob.id]);

    const mergedAuthors = await listAuthors(record.id);
    expect(mergedAuthors.some((author) => author.email === "bob@example.com")).toBe(false);
    const root = await getRepositoryMetrics(record.id, {}, "", "dir");
    expect(root.authors).toHaveLength(1);
    expect(root.authors[0].ownership).toBe(1);
  });

  it("keeps repository and directory metric invariants over filtered data", async () => {
    const repo = createFixtureRepo();
    const record = await analyzeFixture(repo);
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const root = await getRepositoryMetrics(record.id, {}, "", "dir", { limit: 1000, offset: 0, sortBy: "path", sortDir: "asc" });
    expect(root.summary.added).toBe(root.files.reduce((sum, file) => sum + file.added, 0));
    expect(root.summary.removed).toBe(root.files.reduce((sum, file) => sum + file.removed, 0));
    expect(root.summary.churn).toBe(root.files.reduce((sum, file) => sum + file.churn, 0));

    const src = await getRepositoryMetrics(record.id, {}, "src", "dir", { limit: 1000, offset: 0, sortBy: "path", sortDir: "asc" });
    expect(src.summary.added).toBe(src.files.reduce((sum, file) => sum + file.added, 0));
    expect(src.summary.removed).toBe(src.files.reduce((sum, file) => sum + file.removed, 0));
  });

  it("does not list objects first seen after the selected commit window", async () => {
    const repo = createFixtureRepo();
    const record = await analyzeFixture(repo);
    const { getRepositoryMetrics } = await import("../lib/metrics");

    const early = await getRepositoryMetrics(record.id, { from: 1000, to: 2000 }, "", "dir", {
      limit: 1000,
      offset: 0,
      sortBy: "path",
      sortDir: "asc",
    });
    expect(early.files.some((file) => file.path === "main.txt")).toBe(false);
    expect(early.files.some((file) => file.path === "feature.txt")).toBe(false);
  });

  it("marks stale ingest jobs as failed", async () => {
    const repo = createFixtureRepo();
    const { createIngestJob, createRepository, getIngestJobById, markStaleIngestJobsInDb } = await import("../lib/repositories");
    const { withDatabase, run } = await import("../lib/db");

    const record = await createRepository({ name: "stale", sourceType: "path", source: repo, localPath: repo });
    const job = await createIngestJob(record.id);
    await withDatabase((db) => {
      run(db, "UPDATE ingest_jobs SET updated_at = 1 WHERE id = ?", [job.id]);
      run(db, "UPDATE repositories SET status = 'analyzing', updated_at = 1 WHERE id = ?", [record.id]);
      markStaleIngestJobsInDb(db, 0);
    });

    const staleJob = await getIngestJobById(job.id);
    expect(staleJob?.status).toBe("failed");
    expect(staleJob?.stage).toBe("failed");
  });

  it("extracts zip repositories safely and rejects archives without .git", async () => {
    const repo = createFixtureRepo();
    const { createRepository } = await import("../lib/repositories");
    const { analyzeRepository } = await import("../lib/git");
    const { getRepositoryMetrics } = await import("../lib/metrics");
    const { extractRepositoryZip, safeJoin } = await import("../lib/zip");

    const zip = new AdmZip();
    zip.addLocalFolder(repo, "wrapped");
    const record = await createRepository({ name: "zip", sourceType: "zip", source: "fixture.zip", localPath: "" });
    const extracted = extractRepositoryZip(zip.toBuffer(), record.id);
    expect(fs.existsSync(path.join(extracted, ".git"))).toBe(true);
    await analyzeRepository(record.id, extracted);
    const src = await getRepositoryMetrics(record.id, {}, "src", "dir");
    expect(src.summary.churn).toBe(8);

    const badZip = new AdmZip();
    badZip.addFile("file.txt", Buffer.from("not a repo"));
    expect(() => extractRepositoryZip(badZip.toBuffer(), record.id + 1)).toThrow(/\.git/);
    expect(() => safeJoin(tempRoot, "../evil.txt")).toThrow(/Unsafe zip entry path/);
    expect(() => safeJoin(tempRoot, "/tmp/evil.txt")).toThrow(/Unsafe zip entry path/);

  });
});
