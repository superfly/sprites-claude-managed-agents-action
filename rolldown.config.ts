import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  platform: "node",
  resolve: {
    // we never use these imports, but Rolldown's tree shaking doesn't know
    // that. Stubbing them saves ~977 KB (~535 KB minified).
    alias: {
      "@actions/http-client": false,
      "@aws-sdk/credential-provider-node": false,
    },
    // prefer ESM entrypoints. The AWS SDK doesn't properly tree-shake
    // otherwise.
    mainFields: ["module", "main"],
  },
  output: {
    file: "dist/index.js",
    format: "esm",
    codeSplitting: false,
    minify: true,
  },
});
