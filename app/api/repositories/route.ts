import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueIngest } from "@/lib/ingest";
import { normalizeRepoName } from "@/lib/paths";
import { createIngestJob, createRepository, listRepositories } from "@/lib/repositories";
import type { RepoSourceType } from "@/lib/types";

export const runtime = "nodejs";

const createRepositorySchema = z.object({
  sourceType: z.enum(["url", "path"]),
  source: z.string().min(1),
  name: z.string().min(1).optional(),
});

export async function GET() {
  const repositories = await listRepositories();
  return NextResponse.json({ repositories });
}

async function parseCreateRequest(request: Request): Promise<{ sourceType: RepoSourceType; source: string; name?: string; zipBuffer?: Buffer }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return createRepositorySchema.parse(await request.json());
  }

  const form = await request.formData();
  const sourceType = String(form.get("sourceType") ?? "zip") as RepoSourceType;
  const name = form.get("name") ? String(form.get("name")) : undefined;
  if (sourceType !== "zip") {
    const source = String(form.get("source") ?? "");
    if (!source) throw new Error("source is required");
    return { sourceType, source, name };
  }

  const file = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || typeof file.arrayBuffer !== "function") {
    throw new Error("zip ingestion requires a file field");
  }
  const fileName = "name" in file && typeof file.name === "string" && file.name ? file.name : "uploaded.zip";
  const zipBuffer = Buffer.from(await file.arrayBuffer());
  return { sourceType: "zip", source: fileName, name, zipBuffer };
}

export async function POST(request: Request) {
  try {
    const body = await parseCreateRequest(request);
    const name = body.name?.trim() || normalizeRepoName(body.source);
    const repository = await createRepository({
      name,
      sourceType: body.sourceType,
      source: body.source,
      localPath: body.sourceType === "path" ? body.source : "",
    });
    const job = await createIngestJob(repository.id);
    enqueueIngest({
      jobId: job.id,
      repositoryId: repository.id,
      sourceType: body.sourceType,
      source: body.source,
      zipBuffer: body.zipBuffer,
    });

    return NextResponse.json({ repository, job }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
