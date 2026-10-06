import { NextResponse } from "next/server";
import { getIngestJobById, getRepositoryById } from "@/lib/repositories";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const job = await getIngestJobById(Number(id));
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const repository = await getRepositoryById(job.repositoryId);
  return NextResponse.json({ job, repository });
}
