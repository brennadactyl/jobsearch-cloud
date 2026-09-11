/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Fails the build without VITE_API_BASE, so a deploy missing the API URL can't
 * be produced. `dev` is exempt: it still renders without an API. See README.md,
 * "The API URL is a build input".
 */
function requireApiBase(): Plugin {
  return {
    name: "require-api-base",
    apply: "build",
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), "VITE_");
      if (env.VITE_API_BASE?.trim()) return;
      throw new Error(
        "\n\n  VITE_API_BASE is not set - refusing to build.\n\n" +
          "  Without it this build would deploy a page that cannot reach any\n" +
          "  API, and would look completely healthy while doing it.\n\n" +
          "  Copy .env.example to .env.local (gitignored) and set your\n" +
          "  ../server/ deploy's URL:\n\n" +
          "    VITE_API_BASE=https://your-api-worker.your-subdomain.workers.dev\n",
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), requireApiBase()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
