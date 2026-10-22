import { defineConfig } from "tsup";
export default defineConfig({
  entry: { iso: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __cr } from "node:module";
const require = __cr(import.meta.url);`,
  },
  noExternal: [/.*/],
  outExtension: () => ({ js: ".mjs" }),
});
