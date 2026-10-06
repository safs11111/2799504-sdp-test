import { NextResponse } from "next/server";
import { listCommits } from "@/lib/metrics";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 250);
  const commits = await listCommits(Number(id), Number.isFinite(limit) ? limit : 250);
  return NextResponse.json({ commits });
}
