import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@opportunity-os\/(.*)$/, replacement: resolve(dir, "packages/$1/src/index.ts") }],
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // DB e2e tests share one Postgres; run files serially so global cross-source
    // synthesis in one file cannot race another file's assertions.
    fileParallelism: false,
  },
});
