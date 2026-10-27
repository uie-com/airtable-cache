import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { cleanupTempWorkspace, createTempWorkspace } from "@/tests/test-utils";

const workspaces: ReturnType<typeof createTempWorkspace>[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) cleanupTempWorkspace(workspace); });

it("removes only owned legacy preloads and their timestamps at startup", () => {
  const workspace = createTempWorkspace();
  workspaces.push(workspace);
  const next = path.join(workspace.rootDir, "node_modules/next/dist/bin/next");
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.writeFileSync(next, "process.exit(0)");
  fs.writeFileSync(path.join(workspace.publicDir, "cache-legacy.js"), "export const cache = {};\nwindow.airtableCache = cache;\n");
  fs.writeFileSync(path.join(workspace.publicDir, "timestamps-legacy.json"), "{}");
  fs.writeFileSync(path.join(workspace.publicDir, "cache-widget.js"), "export const widget = 1;");
  fs.writeFileSync(path.join(workspace.publicDir, "timestamps-report.json"), "{}");
  const result = spawnSync(process.execPath, [path.resolve("scripts/run-next-with-preloads.mjs"), "start"], { cwd: workspace.rootDir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(workspace.publicDir).sort()).toEqual(["cache-widget.js", "timestamps-report.json"]);
});
