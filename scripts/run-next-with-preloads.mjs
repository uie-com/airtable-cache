import { promises as fileSystem } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "start") {
  console.error(`[airtable-startup] Unsupported Next.js mode: ${mode ?? "missing"}`);
  process.exit(1);
}

async function removeObsoletePublicPreloads() {
  const publicDirectory = path.join(process.cwd(), "public");
  let entries;
  try {
    entries = await fileSystem.readdir(publicDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const obsoleteFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("cache-") || !entry.name.endsWith(".js")) continue;
    const artifactPath = path.join(publicDirectory, entry.name);
    const contents = await fileSystem.readFile(artifactPath, "utf8");
    if (!contents.includes("export const cache =") || !contents.includes("window.airtableCache = cache;")) continue;
    await fileSystem.rm(artifactPath);
    await fileSystem.rm(path.join(publicDirectory, `timestamps-${entry.name.slice(6, -3)}.json`), { force: true });
    obsoleteFiles.push(entry.name);
  }
  if (obsoleteFiles.length > 0) {
    console.info(`[airtable-startup] Removed ${obsoleteFiles.length} obsolete public preload artifact(s).`);
  }
}

await removeObsoletePublicPreloads();

const nextBinaryPath = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const port = process.env.PORT?.trim() || "4444";
const host = process.env.HOST?.trim();
const nextArguments = [nextBinaryPath, mode, "--port", port];

if (host) {
  nextArguments.push("--hostname", host);
}

if (mode === "dev") {
  nextArguments.push("--turbopack");
}

const nextProcess = spawn(process.execPath, nextArguments, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signalName, () => {
    nextProcess.kill(signalName);
  });
}

nextProcess.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
