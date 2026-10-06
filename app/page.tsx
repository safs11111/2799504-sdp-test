"use client";

import * as React from "react";
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
    ["Commit set", metrics.denominatorCommits, "Filtered non-merge commits"],
    ["Added lines", metrics.summary.added, "l+"],
    ["Removed lines", metrics.summary.removed, "l-"],
    ["Growth", metrics.summary.growth, "δ = l+ - l-"],
    ["Churn", metrics.summary.churn, "λ = l+ + l-"],
    ["Modifications", metrics.summary.modifications, "n"],
    ["Frequency", percent(metrics.summary.modificationFrequency), "η = n / |H|"],
    ["Churn rate", number(metrics.summary.churnRate), "ρ = λ / |H|"],
  ] as const;
}

function dateParam(value: string): string | null {
  if (!value) return null;
  return String(Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000));
}

function statusTone(status?: string): string {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  if (status === "queued" || status === "cloning" || status === "extracting" || status === "parsing" || status === "indexing" || status === "analyzing") return "warning";
  return "muted";
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
  const [pathSearchKind, setPathSearchKind] = useState<ObjectKind>("dir");
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
    commitParams.delete("commits");
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
      <section className="hero">
        <div>
          <p className="eyebrow">COMS3011A repository analytics</p>
          <h1>Repo Analysis Tool</h1>
          <p className="hero-copy">Ingest Git repositories, persist SQLite analysis data, filter commit sets, inspect file/directory churn, and resolve author identity from one dashboard.</p>
        </div>
        <div className="hero-stat" aria-label="Selected repository status">
          <span className={`status-pill ${statusTone(selectedRepository?.status)}`}>{selectedRepository?.status ?? "no repository"}</span>
          <strong>{selectedRepository ? `${selectedRepository.progress}%` : "0%"}</strong>
          <span>{selectedRepository?.currentStage ?? "Waiting for ingest"}</span>
        </div>
      </section>

      <section className="panel ingest-panel">
        <div className="section-title">
          <div><h2>Analyze a repository</h2><p>Use a local path, GitHub URL, or zip archive that contains a .git directory.</p></div>
        </div>
        <form className="control-grid" onSubmit={submitRepository}>
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
          <button className="primary-action" disabled={isSubmitting}>{isSubmitting ? "Queueing..." : "Analyze"}</button>
        </form>
        {message && <p className={`notice ${message.includes("failed") || message.includes("Error") ? "error" : "muted"}`}>{message}</p>}
      </section>

      <section className="panel">
        <div className="section-title">
          <div><h2>Repository dashboard</h2><p>Compose repository, author, path, date, and manual commit filters before metrics are aggregated.</p></div>
        </div>
        <div className="control-grid filters">
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
          <label>Path search<input value={pathSearch} onChange={(event) => setPathSearch(event.target.value)} placeholder="src/file.c or .github" /></label>
          <label>Path type
            <select value={pathSearchKind} onChange={(event) => setPathSearchKind(event.target.value as ObjectKind)}>
              <option value="dir">Directory</option>
              <option value="file">File</option>
            </select>
          </label>
          <button type="button" className="secondary-action" disabled={!pathSearch} onClick={() => selectObject(pathSearch, pathSearchKind)}>Open path</button>
        </div>
        {selectedRepository && (
          <div className="repo-strip">
            <div><span className="muted">Current repository</span><code>{selectedRepository.localPath || selectedRepository.source}</code></div>
            <ProgressBar value={selectedRepository.progress} label={selectedRepository.currentStage} />
          </div>
        )}
        <nav className="breadcrumbs" aria-label="Object breadcrumbs">{breadcrumbs.map((crumb) => <button type="button" key={crumb.path || "root"} onClick={() => selectObject(crumb.path, "dir")}>{crumb.label}</button>)}</nav>
      </section>

      <section className="metrics-grid" aria-label="Metric summary cards">
        {metricCards(metrics).map(([label, value, hint]) => <div className="metric-card" key={String(label)}><div className="label">{label}</div><div className="value">{typeof value === "number" ? number(value) : value}</div><p>{hint}</p></div>)}
      </section>

      <MetricVisualizations metrics={metrics} />

      <section className="panel">
        <div className="section-title"><div><h2>Manual commit set</h2><p>Select explicit non-merge commits; the picker itself remains unfiltered by the selected commit set.</p></div></div>
        <div className="toolbar"><button type="button" className="ghost" onClick={() => setSelectedCommits([])}>Clear commit selection</button><span className="muted">Selected commits: {selectedCommits.length}</span></div>
        <div className="table-wrap"><table><thead><tr><th>Use</th><th>Commit</th><th>Author</th><th>Date</th><th>Subject</th></tr></thead><tbody>{commits.slice(0, 20).map((commit) => <tr key={commit.sha}><td><input aria-label={`Use commit ${commit.sha.slice(0, 10)}`} type="checkbox" checked={selectedCommits.includes(commit.sha)} onChange={() => toggleCommit(commit.sha)} /></td><td><code>{commit.sha.slice(0, 10)}</code></td><td>{commit.authorName}</td><td>{new Date(commit.committerDate * 1000).toISOString().slice(0, 10)}</td><td>{commit.subject}</td></tr>)}</tbody></table></div>
      </section>

      <MetricTable title="Directories" rows={metrics.directories} total={metrics.directoryTotal} offset={offset} limit={limit} sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} onOpen={selectObject} onPage={(next) => setOffset(Math.max(0, next))} onLimit={setLimit} />
      <MetricTable title="Files" rows={metrics.files} total={metrics.fileTotal} offset={offset} limit={limit} sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} onOpen={selectObject} onPage={(next) => setOffset(Math.max(0, next))} onLimit={setLimit} />
      <AuthorTable rows={metrics.authors} />
      <AuthorMergePanel authors={authors} target={mergeTarget} sources={mergeSources} setTarget={setMergeTarget} setSources={setMergeSources} onMerge={mergeSelectedAuthors} />
    </main>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  return <div className="progress-card" aria-label={`Progress ${value}%`}><div className="progress-meta"><span>{label}</span><strong>{value}%</strong></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div></div>;
}

function MetricVisualizations({ metrics }: { metrics: MetricsResult }) {
  const flow = [
    { label: "Added", value: metrics.summary.added, className: "added" },
    { label: "Removed", value: metrics.summary.removed, className: "removed" },
    { label: "Growth", value: Math.abs(metrics.summary.growth), className: metrics.summary.growth >= 0 ? "added" : "removed" },
    { label: "Churn", value: metrics.summary.churn, className: "churn" },
  ];
  const topObjects = [...metrics.directories, ...metrics.files]
    .filter((row) => row.churn > 0)
    .sort((a, b) => b.churn - a.churn)
    .slice(0, 6);
  const topAuthors = metrics.authors.slice(0, 6);
  const maxFlow = Math.max(1, ...flow.map((item) => item.value));
  const maxObject = Math.max(1, ...topObjects.map((item) => item.churn));

  return (
    <section className="visual-grid" aria-label="Metric visualizations">
      <div className="panel chart-panel">
        <div className="section-title"><div><h2>Change flow</h2><p>Relative size of l+, l-, absolute growth, and churn for the current filter.</p></div></div>
        <div className="bar-list" aria-label="Change flow chart">
          {flow.map((item) => <div className="bar-row" key={item.label}><span>{item.label}</span><div className="bar-track"><i className={item.className} style={{ width: `${(item.value / maxFlow) * 100}%` }} /></div><strong>{number(item.value)}</strong></div>)}
        </div>
      </div>
      <div className="panel chart-panel">
        <div className="section-title"><div><h2>Top churned objects</h2><p>Highest-churn files and directories in the current page/filter.</p></div></div>
        {topObjects.length === 0 ? <p className="empty-state">No churn in the selected commit set.</p> : <div className="bar-list compact" aria-label="Top churned objects chart">{topObjects.map((item) => <div className="bar-row" key={`${item.kind}:${item.path}`}><span title={item.path}>{item.path || "(root)"}</span><div className="bar-track"><i className="churn" style={{ width: `${(item.churn / maxObject) * 100}%` }} /></div><strong>{number(item.churn)}</strong></div>)}</div>}
      </div>
      <div className="panel chart-panel ownership-panel">
        <div className="section-title"><div><h2>Author ownership</h2><p>Ownership share for the selected repository object.</p></div></div>
        {topAuthors.length === 0 ? <p className="empty-state">No author ownership data for this selection.</p> : <div className="donut-list" aria-label="Author ownership chart">{topAuthors.map((author) => <div className="owner-row" key={author.authorId}><span>{author.name}</span><div className="owner-track"><i style={{ width: `${Math.max(0, Math.min(100, author.ownership * 100))}%` }} /></div><strong>{percent(author.ownership)}</strong></div>)}</div>}
      </div>
    </section>
  );
}

function MetricTable({ title, rows, total, offset, limit, sortBy, sortDir, onSort, onOpen, onPage, onLimit }: { title: string; rows: MetricRow[]; total: number; offset: number; limit: number; sortBy: SortField; sortDir: SortDirection; onSort: (field: SortField) => void; onOpen: (path: string, kind: ObjectKind) => void; onPage: (offset: number) => void; onLimit: (limit: number) => void }) {
  const headers: [string, SortField][] = [["Path", "path"], ["Added", "added"], ["Removed", "removed"], ["Growth", "growth"], ["Churn", "churn"], ["Mods", "modifications"], ["Frequency", "modificationFrequency"], ["Churn rate", "churnRate"]];
  return <section className="panel"><div className="section-title"><div><h2>{title}</h2><p>Sortable, paginated {title.toLowerCase()} metric rows.</p></div></div><div className="toolbar"><button type="button" className="ghost" disabled={offset === 0} onClick={() => onPage(offset - limit)}>Previous</button><span className="muted">Showing {total === 0 ? 0 : offset + 1}-{Math.min(offset + rows.length, total)} of {total}</span><button type="button" className="ghost" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button><label>Rows<select value={limit} onChange={(event) => { onLimit(Number(event.target.value)); onPage(0); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label></div><div className="table-wrap"><table><thead><tr>{headers.map(([label, field]) => <th key={field}><button className="table-sort" type="button" onClick={() => onSort(field)}>{label}{sortBy === field ? ` ${sortDir === "desc" ? "↓" : "↑"}` : ""}</button></th>)}<th>Kind</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={9} className="empty-state">No rows match the current filters.</td></tr> : rows.map((row) => <tr key={`${row.kind}:${row.path}`}><td><button className="link-button" type="button" onClick={() => onOpen(row.path, row.kind)}>{row.path || "(root)"}</button></td><td>{number(row.added)}</td><td>{number(row.removed)}</td><td>{number(row.growth)}</td><td>{number(row.churn)}</td><td>{number(row.modifications)}</td><td>{percent(row.modificationFrequency)}</td><td>{number(row.churnRate)}</td><td><span className="kind-pill">{row.kind}</span></td></tr>)}</tbody></table></div></section>;
}

function AuthorTable({ rows }: { rows: AuthorMetricRow[] }) {
  return <section className="panel"><div className="section-title"><div><h2>Author ownership of selected object</h2><p>Ownership is author churn divided by total object churn.</p></div></div><div className="table-wrap"><table><thead><tr><th>Author</th><th>Modifications</th><th>Churn</th><th>Ownership</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={4} className="empty-state">No author rows match the current filters.</td></tr> : rows.map((row) => <tr key={row.authorId}><td>{row.name} &lt;{row.email}&gt;</td><td>{number(row.modifications)}</td><td>{number(row.churn)}</td><td>{percent(row.ownership)}</td></tr>)}</tbody></table></div></section>;
}

function AuthorMergePanel({ authors, target, sources, setTarget, setSources, onMerge }: { authors: Author[]; target: string; sources: string[]; setTarget: (value: string) => void; setSources: (value: string[]) => void; onMerge: () => void }) {
  return <section className="panel"><div className="section-title"><div><h2>Manual author merge</h2><p>Merge identities after mailmap resolution by reassigning persisted commit author IDs.</p></div></div><div className="control-grid"><label>Keep author<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose target</option>{authors.map((author) => <option key={author.id} value={author.id}>{author.displayName}</option>)}</select></label><label>Merge these authors<select multiple value={sources} onChange={(event) => setSources(Array.from(event.target.selectedOptions).map((option) => option.value))}>{authors.filter((author) => String(author.id) !== target).map((author) => <option key={author.id} value={author.id}>{author.displayName}</option>)}</select></label><button type="button" className="secondary-action" disabled={!target || sources.length === 0} onClick={onMerge}>Merge authors</button></div></section>;
}
