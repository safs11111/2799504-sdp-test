import { NextResponse } from "next/server";
import { getRepositoryMetrics, metricFiltersFromRequest } from "@/lib/metrics";
import type { ObjectKind } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const filters = metricFiltersFromRequest(request.url);
  const objectPath = url.searchParams.get("path") ?? "";
  const kind = (url.searchParams.get("kind") ?? "dir") as ObjectKind;
  if (kind !== "dir" && kind !== "file") {
    return NextResponse.json({ error: "kind must be either 'dir' or 'file'" }, { status: 400 });
  }

  const metrics = await getRepositoryMetrics(Number(id), filters, objectPath, kind);
  return NextResponse.json(metrics);
}
