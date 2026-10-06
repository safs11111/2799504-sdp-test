import { NextResponse } from "next/server";
import { z } from "zod";
import { mergeAuthors } from "@/lib/repositories";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const mergeSchema = z.object({
  targetAuthorId: z.number().int().positive(),
  sourceAuthorIds: z.array(z.number().int().positive()).min(1),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = mergeSchema.parse(await request.json());
    const authors = await mergeAuthors(Number(id), body.targetAuthorId, body.sourceAuthorIds);
    return NextResponse.json({ authors });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
