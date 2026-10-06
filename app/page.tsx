"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Author, AuthorMetricRow, CommitListRow, IngestJob, MetricRow, MetricsResult, ObjectKind, Repository, SortDirection, SortField } from "@/lib/types";

type RepositoriesResponse = { repositories: Repository[] };
type AuthorsResponse = { authors: Author[] };
type CommitsResponse = { commits: CommitListRow[] };
type CreateResponse = { repository?: Repository; job?: IngestJob; error?: string };
type JobResponse = { job: IngestJob; repository: Repository | null };

const emptyMetrics: MetricsResult = {
  denominatorCommits: 0,
  summary: { path: "", kind: "dir", added: 0, removed: 0, growth: 0, churn: 0, modifications: 0, modificationFrequency: 0, churnRate: 0 },
  files: [],
  directories: [],
  authors: [],
  fileTotal: 0,
  directoryTotal: 0,
  page: { limit: 25, offset: 0, sortBy: "churn", sortDir: "desc" },
};

function number(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function percent(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value * 100)}%`;
}

function metricCards(metrics: MetricsResult) {
  return [
    ["Commit set size", metrics.denominatorCommits],
    ["Added lines", metrics.summary.added],
    ["Removed lines", metrics.summary.removed],
    ["Growth", metrics.summary.growth],
    ["Churn", metrics.summary.churn],
    ["Modifications", metrics.summary.modifications],
    ["Modification frequency", percent(metrics.summary.modificationFrequency)],
    ["Churn rate", number(metrics.summary.churnRate)],
  ];
}

function dateParam(value: string): string | null {
  if (!value) return null;
  return String(Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000));
}

export default function Home() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number | null>(null);
  const [sourceType, setSourceType] = useState<"path" | "url" | "zip">("path");
  const [source, setSource] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<MetricsResult>(emptyMetrics);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [commits, setCommits] = useState<CommitListRow[]>([]);
  const [authorId, setAuthorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedCommits, setSelectedCommits] = useState<string[]>([]);
  const [objectPath, setObjectPath] = useState("");
  const [objectKind, setObjectKind] = useState<ObjectKind>("dir");
  const [pathSearch, setPathSearch] = useState("");
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState<SortField>("churn");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeSources, setMergeSources] = useState<string[]>([]);

  const selectedRepository = repositories.find((repo) => repo.id === selectedRepositoryId) ?? null;
  const selectedReady = selectedRepository?.status === "ready";

  async function loadRepositories() {
    const response = await fetch("/api/repositories", { cache: "no-store" });
    const payload = (await response.json()) as RepositoriesResponse;
    setRepositories(payload.repositories);
    setSelectedRepositoryId((current) => current ?? payload.repositories[0]?.id ?? null);
  }

  async function loadAuthors(repoId: number) {
    const response = await fetch(`/api/repositories/${repoId}/authors`, { cache: "no-store" });
    const payload = (await response.json()) as AuthorsResponse;
    setAuthors(payload.authors);
  }

  const queryParams = useMemo(() => {
    const params = new URLSearchParams({ kind: objectKind, path: objectPath, limit: String(limit), offset: String(offset), sortBy, sortDir });
    if (authorId) params.set("authorId", authorId);
    const fromValue = dateParam(from);
    const toValue = dateParam(to);
    if (fromValue) params.set("from", fromValue);
    if (toValue) params.set("to", toValue);
    if (selectedCommits.length > 0) params.set("commits", selectedCommits.join(","));
    return params;
  }, [authorId, from, limit, objectKind, objectPath, offset, selectedCommits, sortBy, sortDir, to]);

  async function loadMetrics() {
    if (!selectedRepositoryId || !selectedReady) {
      setMetrics(emptyMetrics);
      return;
    }
    const response = await fetch(`/api/repositories/${selectedRepositoryId}/metrics?${queryParams.toString()}`, { cache: "no-store" });
    setMetrics((await response.json()) as MetricsResult);
  }

  async function loadCommits() {
    if (!selectedRepositoryId || !selectedReady) {
      setCommits([]);
      return;
    }
    const commitParams = new URLSearchParams(queryParams);
    commitParams.set("limit", "250");
    commitParams.set("offset", "0");
    const response = await fetch(`/api/repositories/${selectedRepositoryId}/commits?${commitParams.toString()}`, { cache: "no-store" });
    const payload = (await response.json()) as CommitsResponse;
    setCommits(payload.commits);
  }

  useEffect(() => { void loadRepositories(); }, []);

  useEffect(() => {
    if (!selectedRepositoryId) return;
    setAuthorId("");
    setSelectedCommits([]);
    setObjectPath("");
    setObjectKind("dir");
    setOffset(0);
    void loadAuthors(selectedRepositoryId);
  }, [selectedRepositoryId]);

  useEffect(() => { void loadMetrics(); void loadCommits(); }, [selectedRepositoryId, selectedReady, queryParams]);

  useEffect(() => {
    const needsPolling = activeJobId !== null || repositories.some((repo) => !["ready", "failed"].includes(repo.status));
    if (!needsPolling) return;
    const handle = window.setInterval(async () => {
      await loadRepositories();
      if (activeJobId !== null) {
        const response = await fetch(`/api/jobs/${activeJobId}`, { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as JobResponse;
          setMessage(`${payload.job.stage}: ${payload.job.message} (${payload.job.progress}%)${payload.job.errorMessage ? ` - ${payload.job.errorMessage}` : ""}`);
          if (payload.job.status === "done" || payload.job.status === "failed") setActiveJobId(null);
        }
      }
    }, 1500);
    return () => window.clearInterval(handle);
  }, [activeJobId, repositories]);

  async function submitRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("Queueing repository ingest...");
    try {
      const requestInit: RequestInit = { method: "POST" };
      if (sourceType === "zip") {
        if (!zipFile) throw new Error("Choose a zip file first");
        const form = new FormData();
        form.set("sourceType", "zip");
        form.set("file", zipFile);
        if (name) form.set("name", name);
        requestInit.body = form;
      } else {
        requestInit.headers = { "Content-Type": "application/json" };
        requestInit.body = JSON.stringify({ sourceType, source, name: name || undefined });
      }
      const response = await fetch("/api/repositories", requestInit);
      const payload = (await response.json()) as CreateResponse;
      if (!response.ok) throw new Error(payload.error ?? "Repository ingest failed");
      setMessage("Repository ingest queued. Progress will update automatically.");
      setSource("");
      setZipFile(null);
      setName("");
      if (payload.repository) setSelectedRepositoryId(payload.repository.id);
      if (payload.job) setActiveJobId(payload.job.id);
      await loadRepositories();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function toggleSort(field: SortField) {
    setOffset(0);
    if (sortBy === field) setSortDir((current) => (current === "desc" ? "asc" : "desc"));
    else { setSortBy(field); setSortDir("desc"); }
  }

  function selectObject(path: string, kind: ObjectKind) {
    setObjectPath(path);
    setObjectKind(kind);
    setOffset(0);
  }

  function toggleCommit(sha: string) {
    setSelectedCommits((current) => current.includes(sha) ? current.filter((value) => value !== sha) : [...current, sha]);
  }

  async function mergeSelectedAuthors() {
    if (!selectedRepositoryId || !mergeTarget || mergeSources.length === 0) return;
    const response = await fetch(`/api/repositories/${selectedRepositoryId}/authors/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetAuthorId: Number(mergeTarget), sourceAuthorIds: mergeSources.map(Number) }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setMessage(payload.error ?? "Author merge failed");
      return;
    }
    setMergeSources([]);
    setMessage("Authors merged. Metrics refreshed.");
    await loadAuthors(selectedRepositoryId);
    await loadMetrics();
  }

  const breadcrumbs = useMemo(() => {
    if (!objectPath) return [{ label: "root", path: "" }];
    const parts = objectPath.split("/");
    return [{ label: "root", path: "" }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join("/") }))];
  }, [objectPath]);

  return (
    <main>
      <h1>Repo Analysis Tool</h1>
      <p>Git repository metrics dashboard with persistent SQLite storage, multi-repo support, filters, zip/URL/path ingestion, and author merging.</p>

      <section className="panel">
        <h2>Analyze a repository</h2>
        <form className="row" onSubmit={submitRepository}>
          <label>Source type
            <select value={sourceType} onChange={(event) => setSourceType(event.target.value as "path" | "url" | "zip")}>
              <option value="path">Local path on server</option>
              <option value="url">Remote Git URL</option>
              <option value="zip">Zip upload with .git</option>
            </select>
          </label>
          {sourceType === "zip" ? (
            <label>Zip file<input required type="file" accept=".zip,application/zip" onChange={(event) => setZipFile(event.target.files?.[0] ?? null)} /></label>
          ) : (
            <label>Source<input required value={source} onChange={(event) => setSource(event.target.value)} placeholder={sourceType === "path" ? "/absolute/path/to/repo" : "https://github.com/DaveGamble/cJSON.git"} /></label>
          )}
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional" /></label>
          <button disabled={isSubmitting}>{isSubmitting ? "Queueing..." : "Analyze"}</button>
        </form>
        {message && <p className={message.includes("failed") || message.includes("Error") ? "error" : "muted"}>{message}</p>}
      </section>

      <section className="panel">
        <h2>Repository dashboard</h2>
        <div className="row">
          <label>Repository
            <select value={selectedRepositoryId ?? ""} onChange={(event) => setSelectedRepositoryId(Number(event.target.value) || null)}>
              <option value="">No repository analyzed yet</option>
              {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.name} ({repo.status} {repo.progress}%)</option>)}
            </select>
          </label>
          <label>Author filter
            <select value={authorId} onChange={(event) => { setAuthorId(event.target.value); setOffset(0); }}>
              <option value="">All authors</option>
              {authors.map((author) => <option key={author.id} value={author.id}>{author.displayName} ({author.commitCount})</option>)}
            </select>
          </label>
          <label>From committer date<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setOffset(0); }} /></label>
          <label>To committer date (exclusive)<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setOffset(0); }} /></label>
          <label>Path search<input value={pathSearch} onChange={(event) => setPathSearch(event.target.value)} placeholder="src/file.c" /></label>
          <button type="button" disabled={!pathSearch} onClick={() => selectObject(pathSearch, pathSearch.includes(".") ? "file" : "dir")}>Open path</button>
        </div>
        {selectedRepository && <p>Current repository: <code>{selectedRepository.localPath || selectedRepository.source}</code>. Stage: {selectedRepository.currentStage}. Stored commits: {number(selectedRepository.commitCount)}.</p>}
        <div className="row">{breadcrumbs.map((crumb) => <button type="button" key={crumb.path || "root"} onClick={() => selectObject(crumb.path, "dir")}>{crumb.label}</button>)}</div>
      </section>

      <section className="panel grid cards">{metricCards(metrics).map(([label, value]) => <div className="card" key={String(label)}><div className="label">{label}</div><div className="value">{typeof value === "number" ? number(value) : value}</div></div>)}</section>

      <section className="panel">
        <h2>Manual commit set</h2>
        <div className="row"><button type="button" onClick={() => setSelectedCommits([])}>Clear commit selection</button><span className="muted">Selected commits: {selectedCommits.length}</span></div>
        <div className="table-wrap"><table><thead><tr><th>Use</th><th>Commit</th><th>Author</th><th>Date</th><th>Subject</th></tr></thead><tbody>{commits.slice(0, 20).map((commit) => <tr key={commit.sha}><td><input type="checkbox" checked={selectedCommits.includes(commit.sha)} onChange={() => toggleCommit(commit.sha)} /></td><td><code>{commit.sha.slice(0, 10)}</code></td><td>{commit.authorName}</td><td>{new Date(commit.committerDate * 1000).toISOString().slice(0, 10)}</td><td>{commit.subject}</td></tr>)}</tbody></table></div>
      </section>

      <MetricTable title="Directories" rows={metrics.directories} total={metrics.directoryTotal} offset={offset} limit={limit} sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} onOpen={selectObject} onPage={(next) => setOffset(Math.max(0, next))} onLimit={setLimit} />
      <MetricTable title="Files" rows={metrics.files} total={metrics.fileTotal} offset={offset} limit={limit} sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} onOpen={selectObject} onPage={(next) => setOffset(Math.max(0, next))} onLimit={setLimit} />
      <AuthorTable rows={metrics.authors} />
      <AuthorMergePanel authors={authors} target={mergeTarget} sources={mergeSources} setTarget={setMergeTarget} setSources={setMergeSources} onMerge={mergeSelectedAuthors} />
    </main>
  );
}

function MetricTable({ title, rows, total, offset, limit, sortBy, sortDir, onSort, onOpen, onPage, onLimit }: { title: string; rows: MetricRow[]; total: number; offset: number; limit: number; sortBy: SortField; sortDir: SortDirection; onSort: (field: SortField) => void; onOpen: (path: string, kind: ObjectKind) => void; onPage: (offset: number) => void; onLimit: (limit: number) => void }) {
  const headers: [string, SortField][] = [["Path", "path"], ["Added", "added"], ["Removed", "removed"], ["Growth", "growth"], ["Churn", "churn"], ["Mods", "modifications"], ["Frequency", "modificationFrequency"], ["Churn rate", "churnRate"]];
  return <section className="panel"><h2>{title}</h2><div className="row"><button type="button" disabled={offset === 0} onClick={() => onPage(offset - limit)}>Previous</button><span className="muted">Showing {offset + 1}-{Math.min(offset + rows.length, total)} of {total}</span><button type="button" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button><label>Rows<select value={limit} onChange={(event) => { onLimit(Number(event.target.value)); onPage(0); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label></div><div className="table-wrap"><table><thead><tr>{headers.map(([label, field]) => <th key={field}><button type="button" onClick={() => onSort(field)}>{label}{sortBy === field ? ` ${sortDir === "desc" ? "↓" : "↑"}` : ""}</button></th>)}<th>Kind</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.kind}:${row.path}`}><td><button type="button" onClick={() => onOpen(row.path, row.kind)}>{row.path || "(root)"}</button></td><td>{number(row.added)}</td><td>{number(row.removed)}</td><td>{number(row.growth)}</td><td>{number(row.churn)}</td><td>{number(row.modifications)}</td><td>{percent(row.modificationFrequency)}</td><td>{number(row.churnRate)}</td><td>{row.kind}</td></tr>)}</tbody></table></div></section>;
}

function AuthorTable({ rows }: { rows: AuthorMetricRow[] }) {
  return <section className="panel"><h2>Author ownership of selected object</h2><div className="table-wrap"><table><thead><tr><th>Author</th><th>Modifications</th><th>Churn</th><th>Ownership</th></tr></thead><tbody>{rows.map((row) => <tr key={row.authorId}><td>{row.name} &lt;{row.email}&gt;</td><td>{number(row.modifications)}</td><td>{number(row.churn)}</td><td>{percent(row.ownership)}</td></tr>)}</tbody></table></div></section>;
}

function AuthorMergePanel({ authors, target, sources, setTarget, setSources, onMerge }: { authors: Author[]; target: string; sources: string[]; setTarget: (value: string) => void; setSources: (value: string[]) => void; onMerge: () => void }) {
  return <section className="panel"><h2>Manual author merge</h2><div className="row"><label>Keep author<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose target</option>{authors.map((author) => <option key={author.id} value={author.id}>{author.displayName}</option>)}</select></label><label>Merge these authors<select multiple value={sources} onChange={(event) => setSources(Array.from(event.target.selectedOptions).map((option) => option.value))}>{authors.filter((author) => String(author.id) !== target).map((author) => <option key={author.id} value={author.id}>{author.displayName}</option>)}</select></label><button type="button" disabled={!target || sources.length === 0} onClick={onMerge}>Merge authors</button></div></section>;
}
