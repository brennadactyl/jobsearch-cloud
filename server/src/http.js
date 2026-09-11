/**
 * Every Response goes through these helpers, so CORS_HEADERS is on every reply
 * - a 404 without them reaches the browser as an opaque network failure with no
 * status to read.
 *
 * Origin `*` is deliberate: the bearer token, never a cookie, is the access
 * boundary, so there is nothing for a hostile origin to ride on.
 */

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  // PUT and DELETE for /api/documents, the one resource addressed by its own
  // URI (./routes/documents.js); a browser preflight refuses unlisted methods.
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  // If-Match rides along with a conditional document write.
  "access-control-allow-headers": "Authorization, Content-Type, If-Match",
  "access-control-max-age": "86400",
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // charset is required: without it Windows PowerShell 5.1's
    // Invoke-RestMethod reads the body as Latin-1, and a GET-merge-POST of
    // /api/config writes the mangled text back.
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Returns the parsed JSON body, or the 400 Response to hand straight back:
 *
 *     const body = await readJson(request);
 *     if (body instanceof Response) return body;
 *
 * @param {Request} request
 * @returns {Promise<Object|Response>}
 */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
}
