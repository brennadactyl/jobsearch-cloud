/**
 * Drives the tracker page in headless Microsoft Edge over the Chrome DevTools
 * Protocol, for checks a unit test can't make: real layout, real wheel events,
 * file uploads, and screenshots to compare against a design.
 *
 * Usage (Node 22+, no dependencies), from a script of your own:
 *
 *   import { openEdge } from "../tools/client/edge-driver.mjs";
 *   const edge = await openEdge({ width: 1280, height: 900 });
 *   await edge.signIn("http://localhost:5190", token, "demo");
 *   await edge.goto("http://localhost:5190/all-leads");
 *   await edge.waitFor(`!!document.querySelector(".md-list")`);
 *   await edge.clickText("Detail");
 *   await edge.wheel(640, 40, 300);
 *   await edge.screenshot("shots/leads.png", ".md");
 *   await edge.close();
 *
 * The page's own session is a token in localStorage, so `signIn` needs one: sign
 * in over the API first (POST /api/login), never by typing a password into the
 * page. Point it at a local server and a test account, not a real person's.
 *
 * Edge's path comes from EDGE_PATH, defaulting to the usual Windows install.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a headless Edge with its own throwaway profile and returns a driver
 * for its one tab. `port` must be free; pick another when two checks run at once.
 */
export async function openEdge({ width = 1280, height = 900, port = 9340 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "edge-driver-"));
  const proc = spawn(
    EDGE,
    ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
  );

  let target;
  for (let i = 0; i < 75 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    } catch {
      /* still starting */
    }
  }
  if (!target) {
    proc.kill();
    throw new Error(`Edge didn't start on port ${port} - is EDGE_PATH right, and the port free?`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });

  /** One protocol call; throws with the protocol's own message on an error. */
  const cdp = (method, params = {}) =>
    new Promise((r, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("DOM.enable");

  const driver = {
    cdp,

    /** Evaluates an expression in the page, awaiting a promise, and returns its value. */
    async js(expression) {
      const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result?.value;
    },

    /** Resizes the viewport. Under 700px wide it also reports a mobile device. */
    async resize(w, h) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    },

    async goto(url, settleMs = 800) {
      await cdp("Page.navigate", { url });
      await sleep(settleMs);
    },

    /**
     * Stores the session the page reads, then reloads signed in. `theme` is
     * "dark" or "light"; omitted, the page follows the OS.
     */
    async signIn(origin, token, name, theme) {
      await driver.goto(`${origin}/`);
      const sets = [`localStorage.setItem("tracker_token", ${JSON.stringify(token)})`, `localStorage.setItem("tracker_name", ${JSON.stringify(name)})`];
      if (theme) sets.push(`localStorage.setItem("bjs.theme", ${JSON.stringify(theme)})`);
      await driver.js(`${sets.join("; ")}; true`);
      await cdp("Page.reload");
      await sleep(800);
    },

    /** Polls a page expression until it's truthy; throws naming it after `ms`. */
    async waitFor(expression, ms = 10000) {
      for (let t = 0; t < ms; t += 150) {
        if (await driver.js(expression)) return;
        await sleep(150);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },

    /** Clicks the first button whose trimmed text is exactly `text`. */
    async clickText(text) {
      await driver.js(`(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!b) throw new Error("no button reading " + ${JSON.stringify(text)});
        b.click();
        return true;
      })()`);
      await sleep(200);
    },

    /** Clicks the element matching a CSS selector, e.g. 'button[aria-label="Close"]'. */
    async click(selector) {
      await driver.js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("nothing matches " + ${JSON.stringify(selector)});
        el.click();
        return true;
      })()`);
      await sleep(200);
    },

    /**
     * Sets an input, textarea or select the way React notices: through the
     * native value setter, then the event React listens for.
     */
    async setValue(selector, value) {
      await driver.js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("nothing matches " + ${JSON.stringify(selector)});
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        return true;
      })()`);
      await sleep(200);
    },

    /** Attaches local files to a file input, as if picked. Works on a hidden input. */
    async attach(selector, ...files) {
      const doc = await cdp("DOM.getDocument", { depth: -1 });
      const node = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      if (!node.nodeId) throw new Error(`nothing matches ${selector}`);
      await cdp("DOM.setFileInputFiles", { nodeId: node.nodeId, files: files.map((f) => resolve(f)) });
      await sleep(400);
    },

    /** Turns a real mouse wheel at a viewport point. Positive `dy` scrolls down. */
    async wheel(x, y, dy, dx = 0) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
      await sleep(400);
    },

    /**
     * Saves a PNG of the viewport, or of the element matching `selector` with a
     * `pad`-pixel margin. Creates the folder.
     */
    async screenshot(path, selector, pad = 12) {
      const params = { format: "png" };
      if (selector) {
        const box = await driver.js(`(() => {
          const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
          return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
        })()`);
        if (!box) throw new Error(`nothing to screenshot: ${selector}`);
        params.clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 1 };
      }
      const r = await cdp("Page.captureScreenshot", params);
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, Buffer.from(r.data, "base64"));
    },

    async close() {
      ws.close();
      proc.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Edge can hold the profile a moment after exit; the OS clears tmp */
      }
    },
  };
  return driver;
}
