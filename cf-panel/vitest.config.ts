import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          JWT_SECRET: "test-jwt-secret-key-for-vitest-1234567890",
          MIGRATION_TOKEN: "test-migration-token-1234567890",
        },
      },
    }),
  ],
});
