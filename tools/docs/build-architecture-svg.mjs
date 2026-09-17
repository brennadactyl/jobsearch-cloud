// Derives docs/architecture.svg from the diagram inlined in docs/architecture.html.
// Run from the repo root after changing the diagram.
//
// The HTML is the source because it themes the diagram with CSS variables; the
// README embeds the SVG as an image, where no stylesheet applies, so every
// variable is resolved to its light-theme value here. It fails rather than
// write an SVG with a colour left unresolved, and checks that the text and the
// aria-label match the HTML's.
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("docs/architecture.html", "utf8").replace(/\r\n/g, "\n");
const m = html.match(/^([ \t]*)<svg ([^>]*)>([\s\S]*?)\n[ \t]*<\/svg>/m);
if (!m) throw new Error("no inline svg");
const [, indent, attrs, body] = m;

const light = {
  "--surface": "#FFFFFF", "--line-strong": "#C3C5CE", "--accent": "#4548D6",
  "--accent-soft": "#E9E9FB", "--private": "#A9660E", "--private-soft": "#F7ECDA",
};
const NL = String.fromCharCode(10);

let out = body
  .replace(/var\((--[\w-]+)\)/g, (_, v) => {
    if (!light[v]) throw new Error("no light value for " + v);
    return light[v];
  })
  .replace(/currentColor/g, "#1D2027")
  .replace(/font-family="([^",]+),/g, (_, f) => `font-family="'${f.trim()}',`)
  .split(NL)
  .map((l) => (l.startsWith(indent + "  ") ? l.slice(indent.length) : l.trim() === "" ? "" : l))
  .join(NL);
while (out.startsWith(NL)) out = out.slice(1);

const vb = attrs.match(/viewBox="0 0 (\d+) (\d+)"/);
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>` + NL +
  `  <rect x="0" y="0" width="${vb[1]}" height="${vb[2]}" fill="#FAFAF7" />` + NL + NL +
  out + NL + `</svg>` + NL;
if (/var\(|currentColor/.test(svg)) throw new Error("unresolved colour left in svg");
writeFileSync("docs/architecture.svg", svg);

const texts = (s) => [...s.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((t) => t[1]);
const a = texts(body), b = texts(svg);
console.log(`svg written: ${svg.length} bytes, ${b.length} text nodes`);
console.log(JSON.stringify(a) === JSON.stringify(b) ? "PASS  svg text identical to the html diagram" : "FAIL  svg text differs");
const label = (s) => (s.match(/aria-label="([^"]*)"/) || [])[1];
console.log(label(html) === label(svg) ? "PASS  aria-label identical" : "FAIL  aria-label differs");
