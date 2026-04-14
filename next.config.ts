import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: configDirectory,
  async rewrites() {
    return {
      fallback: [
        {
          // Let browser clients keep requesting the historical public preload path even when the
          // generated file is temporarily missing. The route handler will rebuild it from snapshot.
          source: "/cache-:siteToken.js",
          destination: "/preload-cache/:siteToken",
        },
      ],
    };
  },
};

export default nextConfig;
