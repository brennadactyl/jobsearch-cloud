// A stand-in for the tracker API, for tools/tracker-rig/run.sh. Every request is
// appended to the log as one line - the version label and scenario from the URL
// prefix, then method, path, auth, content type and body - so two tracker.ps1
// versions can be compared on exactly what they send.
//
// Usage: node stub.mjs <port> <logFile>
// A URL looks like /<version>/<scenario>/api/...; the scenario picks a canned
// failure or reply shape (retry: one 500 then success; e400; e503; unscoped;
// mixed; noranked; drift: a kind the route coerced; tabs: the tab counts a
// multi-tab search gets back) or the normal response.
import http from "node:http"; import fs from "node:fs";
const log = process.argv[3]; const hits = {};
const J = (res, code, obj) => { res.writeHead(code, {"content-type":"application/json; charset=utf-8"}); res.end(typeof obj==="string"?obj:JSON.stringify(obj)); };
http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const [, variant, scen, ...rest] = req.url.split("/"); const path = "/" + rest.join("/");
    fs.appendFileSync(log, `${variant} ${scen} ${req.method} ${path} auth=${req.headers.authorization} ct=${req.headers["content-type"]||""} body=${body}\n`);
    const key = variant+scen+path; hits[key] = (hits[key]||0)+1;
    if (scen === "retry" && hits[key] === 1) return J(res, 500, "error code: 1101 <html>\n  <body>boom</body></html>");
    if (scen === "e400") return J(res, 400, {error:"bad request"});
    if (scen === "e503") return J(res, 503, {error:"no binding"});
    if (path === "/api/config") return J(res, 200, {tracks:[{key:"SWE"},{key:"swe-ai",fed_by:"SWE"},{key:"swe-tech",fed_by:"SWE"},{key:"CPM"},null],settings:{priority_locations:scen==="noranked"?"":" Seattle area, Portland OR,, Remote US "}});
    if (path.startsWith("/api/dedup/")) {
      const k = path.split("/")[3].split("?")[0];
      const scoped = scen==="mixed" ? k!=="swe-tech" : scen!=="unscoped";
      const d = { leads:[{id:1,url:`https://x/${k}/1`,status:"new",recheck:true},{id:2,url:`https://x/${k}/2`,status:"applied"}], screened:["https://s/1",`https://s/${k}`] };
      if (scoped) d.scope = {kept:3,of:10,companies:25,since:"2026-09-10",recheck:{budget:5,eligible:40}};
      return J(res, 200, d);
    }
    if (path === "/api/coverage/SWE") return J(res, 200, {batch:3,cursor:40,total:300,companies:[{company:"Acme",board:"greenhouse",note:" slow "},{company:"Béta Co"},{company:"Gamma",note:"x"}]});
    if (path.startsWith("/api/coverage/SWE?all=1")) return J(res, 200, {companies:[{company:"Initech (Globex)",aliases:["Initrode","Initech Corp."]},{company:"Acme"}]});
    if (path === "/api/leads") return J(res, 200, {added:2,duplicates:1,excluded:0});
    if (path === "/api/screened") return J(res, 200, {added:2,duplicates:1,excluded:0,
      ...(scen==="drift"?{kinds_coerced:{"wrong domain":1}}:{}),
      ...(scen==="tabs"?{tabs_named:1,tabs_of:3,tabs_filed_at_root:{"organic-search-management":1}}:{})});
    if (path === "/api/verified") return J(res, 200, {stamped:2,unmatched:1,unmatchedUrls:["https://nope/1"]});
    if (path === "/api/delist") return J(res, 200, {removed:1,kept:1,unmatched:2,unmatchedUrls:["https://nope/1","https://nope/2"]});
    if (path === "/api/coverage") return J(res, 200, {recorded:3,added:1,withheld:1,excluded:0,cursor:43});
    if (path === "/api/runs") return J(res, 200, {also:[{key:"swe-ai"},{key:"swe-tech"}]});
    J(res, 404, {error:"no stub for "+path});
  });
}).listen(+process.argv[2]);
