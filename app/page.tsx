"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AuthorMetricRow, MetricRow, MetricsResult, Repository } from "@/lib/types";

type RepositoriesResponse = { repositories: Repository[] };

type CreateResponse = { repository?: Repository; error?: string };

const emptyMetrics: MetricsResult = {
  denominatorCommits: 0,
  summary: {
    path: "",
    kind: "dir",
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modificationFrequency: 0,
    churnRate: 0,
  },
  files: [],
  directories: [],
  authors: [],
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

export default function Home() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number | null>(null);
  const [sourceType, setSourceType] = useState<"path" | "url">("path");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsResult>(emptyMetrics);
  const [authorId, setAuthorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const selectedRepository = repositories.find((repo) => repo.id === selectedRepositoryId) ?? null;

  async function loadRepositories() {
    const response = await fetch("/api/repositories", { cache: "no-store" });
    const payload = (await response.json()) as RepositoriesResponse;
    setRepositories(payload.repositories);
    setSelectedRepositoryId((current) => current ?? payload.repositories[0]?.id ?? null);
  }

  const metricsUrl = useMemo(() => {
    if (!selectedRepositoryId) return null;
    const params = new URLSearchParams({ kind: "dir", path: "" });
    if (authorId) params.set("authorId", authorId);
    if (from) params.set("from", String(Math.floor(new Date(from).getTime() / 1000)));
    if (to) params.set("to", String(Math.floor(new Date(to).getTime() / 1000)));
    return `/api/repositories/${selectedRepositoryId}/metrics?${params.toString()}`;
  }, [authorId, from, selectedRepositoryId, to]);

  async function loadMetrics() {
    if (!metricsUrl) {
      setMetrics(emptyMetrics);
      return;
    }
    const response = await fetch(metricsUrl, { cache: "no-store" });
    setMetrics((await response.json()) as MetricsResult);
  }

  useEffect(() => {
    void loadRepositories();
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [metricsUrl]);

  async function submitRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("Analyzing repository. This first foundation flow runs synchronously, so large repositories may take a while.");
    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType, source, name: name || undefined }),
      });
      const payload = (await response.json()) as CreateResponse;
      if (!response.ok) throw new Error(payload.error ?? "Repository analysis failed");
      setMessage("Repository analyzed successfully.");
      setSource("");
      setName("");
      await loadRepositories();
      if (payload.repository) setSelectedRepositoryId(payload.repository.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const authorOptions = useMemo(() => metrics.authors, [metrics.authors]);

  return (
    <main>
      <h1>Repo Analysis Tool</h1>
      <p>
        Runnable foundation for repository ingestion, persistent SQLite-backed metrics, file/directory/repository rollups,
        commit-set denominators, and author ownership.
      </p>

      <section className="panel">
        <h2>Analyze a repository</h2>
        <form className="row" onSubmit={submitRepository}>
          <label>
            Source type
            <select value={sourceType} onChange={(event) => setSourceType(event.target.value as "path" | "url")}>
              <option value="path">Local path on server</option>
              <option value="url">Remote Git URL</option>
            </select>
          </label>
          <label>
            Source
            <input
              required
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder={sourceType === "path" ? "/absolute/path/to/repo" : "https://github.com/DaveGamble/cJSON.git"}
            />
          </label>
          <label>
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional" />
          </label>
          <button disabled={isSubmitting}>{isSubmitting ? "Analyzing..." : "Analyze"}</button>
        </form>
        {message && <p className={message.includes("success") ? "success" : "muted"}>{message}</p>}
      </section>

      <section className="panel">
        <h2>Repository dashboard</h2>
        <div className="row">
          <label>
            Repository
            <select
              value={selectedRepositoryId ?? ""}
              onChange={(event) => setSelectedRepositoryId(Number(event.target.value) || null)}
            >
              <option value="">No repository analyzed yet</option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name} ({repo.status})
                </option>
              ))}
            </select>
          </label>
          <label>
            Author filter
            <select value={authorId} onChange={(event) => setAuthorId(event.target.value)}>
              <option value="">All authors</option>
              {authorOptions.map((author) => (
                <option key={author.authorId} value={author.authorId}>
                  {author.name} &lt;{author.email}&gt;
                </option>
              ))}
            </select>
          </label>
          <label>
            From committer date
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To committer date (exclusive)
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        {selectedRepository && (
          <p>
            Current repository: <code>{selectedRepository.localPath || selectedRepository.source}</code>. Stored commits:{" "}
            {number(selectedRepository.commitCount)}.
          </p>
        )}
      </section>

      <section className="panel grid cards">
        {metricCards(metrics).map(([label, value]) => (
          <div className="card" key={String(label)}>
            <div className="label">{label}</div>
            <div className="value">{typeof value === "number" ? number(value) : value}</div>
          </div>
        ))}
      </section>

      <MetricTable title="Top directories" rows={metrics.directories} />
      <MetricTable title="Top files" rows={metrics.files} />
      <AuthorTable rows={metrics.authors} />
    </main>
  );
}

function MetricTable({ title, rows }: { title: string; rows: MetricRow[] }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Kind</th>
              <th>Added</th>
              <th>Removed</th>
              <th>Growth</th>
              <th>Churn</th>
              <th>Mods</th>
              <th>Frequency</th>
              <th>Churn rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.kind}:${row.path}`}>
                <td>{row.path || "(root)"}</td>
                <td>{row.kind}</td>
                <td>{number(row.added)}</td>
                <td>{number(row.removed)}</td>
                <td>{number(row.growth)}</td>
                <td>{number(row.churn)}</td>
                <td>{number(row.modifications)}</td>
                <td>{percent(row.modificationFrequency)}</td>
                <td>{number(row.churnRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AuthorTable({ rows }: { rows: AuthorMetricRow[] }) {
  return (
    <section className="panel">
      <h2>Author ownership of selected repository object</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Author</th>
              <th>Modifications</th>
              <th>Churn</th>
              <th>Ownership</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.authorId}>
                <td>
                  {row.name} &lt;{row.email}&gt;
                </td>
                <td>{number(row.modifications)}</td>
                <td>{number(row.churn)}</td>
                <td>{percent(row.ownership)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
