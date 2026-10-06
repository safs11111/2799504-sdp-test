import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("dashboard UI regression coverage", () => {
  it("loads the global stylesheet through the app layout", () => {
    const layout = read("app/layout.tsx");
    const styles = read("app/styles.css");

    expect(layout).toContain('import "./styles.css"');
    expect(styles).toContain(".hero");
    expect(styles).toContain(".metrics-grid");
    expect(styles).toContain(".visual-grid");
    expect(styles).toContain(".chart-panel");
    expect(styles).toContain(".pie-chart");
    expect(styles).toContain(".ownership-summary");
    expect(styles).toContain("background:");
  });

  it("renders chart and visualization sections in the dashboard source", () => {
    const page = read("app/page.tsx");

    expect(page).toContain("MetricVisualizations");
    expect(page).toContain("Change flow");
    expect(page).toContain("Added vs removed");
    expect(page).toContain("Added versus removed pie chart");
    expect(page).toContain("Top churned objects");
    expect(page).toContain("Author ownership");
    expect(page).toContain("aria-label=\"Metric visualizations\"");
  });

  it("keeps the required explicit path selector, commit-picker fix, and author pagination", () => {
    const page = read("app/page.tsx");

    expect(page).toContain("Path type");
    expect(page).toContain("setPathSearchKind");
    expect(page).toContain('commitParams.delete("commits")');
    expect(page).toContain("Next authors");
    expect(page).toContain("Search authors");
    expect(page).toContain("Next merge page");
    expect(page).not.toContain('pathSearch.includes(".")');
  });

  it("documents clean-clone commands and required design decisions", () => {
    const readme = read("README.md");

    expect(readme).toContain("Node.js 20 recommended");
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("npm test");
    expect(readme).toContain("## Database design");
    expect(readme).toContain("## Derived vs stored design decisions");
    expect(readme).toContain("## Third-party packages");
    expect(readme).toContain("Assisted-by:");
  });
});
