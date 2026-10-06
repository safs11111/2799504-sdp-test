import { analyzeRepository, cloneRepository, ensureGitAvailable, ensureGitRepository } from "./git";
import { updateIngestJob, updateRepositoryLocalPath, updateRepositoryProgress, updateRepositoryStatus } from "./repositories";
import type { RepoSourceType } from "./types";
import { extractRepositoryZip } from "./zip";

type IngestInput = {
  jobId: number;
  repositoryId: number;
  sourceType: RepoSourceType;
  source: string;
  zipBuffer?: Buffer;
};

let queue: Promise<void> = Promise.resolve();

async function setProgress(input: IngestInput, status: "cloning" | "extracting" | "analyzing" | "indexing" | "ready" | "failed", progress: number, message: string, error: string | null = null) {
  const stage = status === "ready" ? "done" : status === "failed" ? "failed" : status === "analyzing" ? "parsing" : status;
  await updateRepositoryProgress(input.repositoryId, status, stage, progress, error);
  await updateIngestJob(input.jobId, status === "ready" ? "done" : status === "failed" ? "failed" : "running", stage, progress, message, error);
}

async function runIngest(input: IngestInput): Promise<void> {
  try {
    ensureGitAvailable();
    await setProgress(input, "analyzing", 1, "Starting ingest");

    let localPath = input.source;
    if (input.sourceType === "url") {
      await setProgress(input, "cloning", 5, "Cloning repository");
      localPath = cloneRepository(input.source, input.repositoryId);
      await updateRepositoryLocalPath(input.repositoryId, localPath);
    } else if (input.sourceType === "zip") {
      if (!input.zipBuffer) throw new Error("Zip upload did not include file data");
      await setProgress(input, "extracting", 5, "Extracting zip file");
      localPath = extractRepositoryZip(input.zipBuffer, input.repositoryId);
      await updateRepositoryLocalPath(input.repositoryId, localPath);
    } else {
      ensureGitRepository(localPath);
    }

    await analyzeRepository(input.repositoryId, localPath, async (stage, progress, message) => {
      const repoStatus = stage === "indexing" ? "indexing" : stage === "done" ? "ready" : "analyzing";
      await updateRepositoryProgress(input.repositoryId, repoStatus, stage, progress);
      await updateIngestJob(input.jobId, stage === "done" ? "done" : "running", stage, progress, message);
    });
    await setProgress(input, "ready", 100, "Repository analysis complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRepositoryStatus(input.repositoryId, "failed", message);
    await setProgress(input, "failed", 100, "Repository ingest failed", message);
  }
}

export function enqueueIngest(input: IngestInput): void {
  queue = queue.then(() => runIngest(input), () => runIngest(input));
}
