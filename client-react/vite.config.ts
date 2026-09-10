/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Refuses to build without an API URL.
 *
 * This is `client/predeploy-check.mjs`'s job moved one step earlier, and it is
 * the one place this client is strictly safer than the page it may replace.
 * Over there the API URL is a gitignored runtime file, so a checkout missing it
 * builds and deploys perfectly happily into a site that tells every visitor
 * "This deployment has no API URL configured" - which is exactly what happened
 * on 2026-09-08, from a worktree, and took the sign-in page down for hours.
 *
 * Here it is a build input. A build without it fails, so that deploy cannot be
 * produced in the first place. `dev` is exempt: a dev server with no API is a
 * useful thing to run (the components render, the requests fail), and failing
 * to start would just be in the way.
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
    // Domain logic and components only. The scaffold's own files are excluded
    // by living outside src/.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
