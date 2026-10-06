import { NextResponse } from "next/server";
import { listAuthors } from "@/lib/repositories";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const authors = await listAuthors(Number(id));
  return NextResponse.json({ authors });
}
