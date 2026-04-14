import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "coverage/**",
      "data/**",
      "next-env.d.ts",
      "node_modules/**",
      "public/cache*.js",
      "public/timestamps-*.json",
    ],
  },
];

export default config;
