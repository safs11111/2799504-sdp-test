import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { repositoriesDir } from "./paths";

function safeJoin(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe zip entry path: ${relativePath}`);
  }
  const destination = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe zip entry path: ${relativePath}`);
  }
  return destination;
}

function commonSingleRoot(entries: string[]): string | null {
  const topLevels = new Set(entries.map((entry) => entry.replace(/\\/g, "/").split("/").filter(Boolean)[0]).filter(Boolean));
  if (topLevels.size !== 1) return null;
  const [root] = [...topLevels];
  return root ?? null;
}

function hasGitMarker(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

export function extractRepositoryZip(zipBuffer: Buffer, repositoryId: number): string {
  const targetRoot = path.join(repositoriesDir(), String(repositoryId));
  if (fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error("Zip file is empty");

  const entryNames = entries.map((entry) => entry.entryName).filter(Boolean);
  const stripRoot = commonSingleRoot(entryNames);

  for (const entry of entries) {
    let entryName = entry.entryName.replace(/\\/g, "/");
    if (!entryName || entryName.endsWith("/")) {
      if (entryName) fs.mkdirSync(safeJoin(targetRoot, stripRoot && entryName.startsWith(`${stripRoot}/`) ? entryName.slice(stripRoot.length + 1) : entryName), { recursive: true });
      continue;
    }
    if (stripRoot && entryName === stripRoot) continue;
    if (stripRoot && entryName.startsWith(`${stripRoot}/`)) entryName = entryName.slice(stripRoot.length + 1);
    if (!entryName) continue;

    const destination = safeJoin(targetRoot, entryName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.getData());
  }

  if (hasGitMarker(targetRoot)) return targetRoot;

  const children = fs.readdirSync(targetRoot, { withFileTypes: true }).filter((child) => child.isDirectory());
  if (children.length === 1) {
    const nested = path.join(targetRoot, children[0].name);
    if (hasGitMarker(nested)) return nested;
  }

  throw new Error("Zip file must contain a repository with a .git file or directory");
}
