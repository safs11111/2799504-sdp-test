# Repo Analysis Tool (RAT)

A Next.js + TypeScript dashboard that ingests Git repositories, persists analysis data in SQLite, and displays repository, directory, file, commit-set, and author metrics.

## Required runtime

- Node.js 20 recommended. Node.js 18+ is supported by the current dependency set.
- `git` must be available on `PATH`.
- Internet access is required only for remote Git URL ingestion.

## Install, run, and test

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Production build and run:

```bash
npm run build
npm run start
```

## Database design

RAT uses SQLite through `sql.js`. The persistent database is exported to `./data/rat.sqlite`, and cloned/extracted repositories are stored in `./data/repositories/`. The `data/` directory is intentionally gitignored. Tests use isolated temporary databases via `RAT_DATA_DIR`, `RAT_DB_PATH`, and `RAT_REPOS_DIR`.

Core tables:

- `repositories`: repository source, local path, ingest status, progress, stage, and commit count.
- `ingest_jobs`: persisted background job status and progress.
- `authors`: mailmap-resolved author identities.
- `commits`: non-merge commits, committer timestamps, ordinal order, raw author identity, and resolved author ID.
- `changes`: per-file numstat deltas keyed by repository, commit SHA, and path.
- `dir_metrics`: recursive directory rollups keyed by repository, commit SHA, and directory path.
- `object_lifetimes`: first/last observed ordinals for file and directory listing boundaries.

Required indexes include repository/path/SHA, repository/directory/SHA, and repository/committer-date access patterns for filtered metric queries.

## Derived vs stored design decisions

Stored state is limited to data needed for persistence and fast recomputation: commits, file deltas, directory rollups, authors, ingest jobs, repository status, and object lifetime boundaries. Display metrics are derived at query time after composing filters for author, object path, committer-date range, and manual commit list. Manual author merge updates persisted commit author IDs, so ownership and author metrics are recomputed from stored facts instead of cached UI state.

Git analysis uses one non-merge `git log --numstat -z -M50% --root` pass with committer timestamps. Binary rows are skipped, renames are attributed to the new path, and deletions keep removed-line deltas on the deleted path.

## UI features

- Repository ingestion from local path, remote Git URL, or zip upload containing `.git`.
- Multi-repository switcher and staged ingest progress.
- Filter bar for author, date range, explicit path type, path, and manual commit set.
- Summary cards, sortable/paginated directory and file tables, breadcrumbs, author ownership, and manual author merge.
- Visualizations for change flow, top churned objects, and author ownership.

## Third-party packages

- `next`, `react`, `react-dom`: web application framework and UI runtime.
- `typescript`: strict typing for application and tests.
- `sql.js`: SQLite-compatible persistence without native compilation, suitable for clean clone reliability in this environment.
- `adm-zip`: minimal zip upload extraction support.
- `zod`: request validation for API inputs.
- `vitest`: automated test runner.
- `@testing-library/react` and `jsdom`: UI component tests.
- `tsx`: local TypeScript execution for smoke/timing scripts.

## Evidence and validation

Run before submission:

```bash
npm run typecheck
npm test
npm run build
```

cJSON smoke evidence collected in this environment:

- Repository: `https://github.com/DaveGamble/cJSON.git`
- Non-merge commits: `955`
- RAT local-path analysis time: approximately `1.1s`

## AI declaration

```text
Assisted-by: Qoder[performance tier], Qoder[auto tier]
```
