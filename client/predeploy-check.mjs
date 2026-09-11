/**
 * Refuses the deploy when public/local-config.js is missing: an [assets] deploy
 * replaces the live file set, so it would delete the live copy. Runs only as
 * npm's `predeploy` hook, not for a bare `wrangler deploy`. See client/README.md.
 */
import { existsSync } from "node:fs";

if (!existsSync(new URL("public/local-config.js", import.meta.url))) {
  console.error(
    "\n  public/local-config.js is missing - refusing to deploy.\n\n" +
      "  It's gitignored, so this checkout never had it (a git worktree or a\n" +
      "  fresh clone). Deploying now would not just skip it - it would DELETE\n" +
      "  it from the live site, and the sign-in page would show \"This\n" +
      "  deployment has no API URL configured\" to everyone.\n\n" +
      "  Deploy from a checkout on main that has the file, or copy it in:\n" +
      "    copy public\\local-config.example.js public\\local-config.js\n" +
      "  then set LOCAL_API_BASE to your server Worker's URL.\n"
  );
  process.exit(1);
}
