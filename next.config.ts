import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: configDirectory,
};

export default nextConfig;
