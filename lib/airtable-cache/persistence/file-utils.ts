import { constants as fileSystemConstants, promises as fileSystem } from "fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { CacheEntryState, stripOffsetField } from "@/lib/airtable-cache/types";

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function buildPreloadScript(entries: Record<string, CacheEntryState>): string {
  const preloadBody = Object.fromEntries(
    Object.entries(entries).map(([cacheKey, entry]) => [cacheKey, stripOffsetField(entry.body)]),
  );

  // JSON.parse intentionally creates an own `__proto__` property instead of invoking
  // object-literal prototype semantics when a cached response contains that key.
  const serializedBody = JSON.stringify(JSON.stringify(preloadBody));
  return `export const cache = JSON.parse(${serializedBody});\nwindow.airtableCache = cache;\n`;
}

export const PRELOAD_FILE_PATTERN = /^cache-([a-z0-9._~-]{1,246})\.js$/;

export function preloadTokenFromFileName(fileName: string): string | null {
  return PRELOAD_FILE_PATTERN.exec(fileName)?.[1] ?? null;
}

export function isCanonicalPreloadToken(token: string): boolean {
  return /^[a-z0-9._~-]{1,246}$/.test(token);
}

export async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.atc-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );

  try {
    const handle = await fileSystem.open(
      temporaryPath,
      fileSystemConstants.O_CREAT | fileSystemConstants.O_EXCL | fileSystemConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporaryPath, filePath);
  } finally {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
