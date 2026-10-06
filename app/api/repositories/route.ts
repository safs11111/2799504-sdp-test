import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeRepository, cloneRepository, ensureGitRepository } from "@/lib/git";
import { normalizeRepoName } from "@/lib/paths";
import { createRepository, listRepositories, updateRepositoryLocalPath, updateRepositoryStatus } from "@/lib/repositories";

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

export async function POST(request: Request) {
  const body = createRepositorySchema.parse(await request.json());
  const name = body.name?.trim() || normalizeRepoName(body.source);
  const repository = await createRepository({
    name,
    sourceType: body.sourceType,
    source: body.source,
    localPath: body.sourceType === "path" ? body.source : "",
  });

  try {
    let localPath = body.source;
    if (body.sourceType === "url") {
      await updateRepositoryStatus(repository.id, "analyzing");
      localPath = cloneRepository(body.source, repository.id);
      await updateRepositoryLocalPath(repository.id, localPath);
    } else {
      ensureGitRepository(localPath);
    }

    await analyzeRepository(repository.id, localPath);
    const repositories = await listRepositories();
    const completed = repositories.find((repo) => repo.id === repository.id) ?? repository;
    return NextResponse.json({ repository: completed }, { status: 201 });
  } catch (error) {
    await updateRepositoryStatus(repository.id, "failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), repositoryId: repository.id },
      { status: 400 },
    );
  }
}
