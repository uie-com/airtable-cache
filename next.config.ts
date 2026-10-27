import path from "node:path";
import { fileURLToPath } from "node:url";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  outputFileTracingRoot: configDirectory,
};

export default nextConfig;
