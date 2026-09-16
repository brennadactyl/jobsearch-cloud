/**
 * The text of a Word resume (.docx), read by a fixed procedure: no model, no
 * dependency, the same text every time (docs/word-resumes-plan.md).
 *
 * A .docx is a zip. The procedure opens it with the zip's own central
 * directory, inflates `word/document.xml` with the platform's
 * DecompressionStream, and walks the XML: the text of each run in order, a line
 * per paragraph, and a table's cells joined by tabs with a line per row.
 *
 * Only the main document part is read, not headers, footers or comments, which
 * on a resume repeat the name or hold nothing a search reads.
 */

// A resume's document.xml is tens of kilobytes. The cap refuses a file that
// inflates into something no resume is - a zip bomb, or a document with a book
// pasted in - before it is held in memory.
const MAX_XML_BYTES = 20 * 1024 * 1024;

export const MIN_WORDS = 50;

/** Why a .docx could not be read, in a sentence for the person who uploaded it. */
export class DocxError extends Error {}

const SIG_END_OF_DIRECTORY = 0x06054b50;
const SIG_DIRECTORY_ENTRY = 0x02014b50;
const SIG_LOCAL_HEADER = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;

/**
 * The bytes of one file inside a zip.
 *
 * Sizes and the data's position come from the central directory, never from
 * the local header: a zip written as a stream (bit 3 set) leaves the local
 * header's sizes as zero and puts them after the data, and only the central
 * directory holds them reliably.
 *
 * @param {Uint8Array} zip
 * @param {string} wanted the entry's name, e.g. "word/document.xml"
 * @returns {Promise<Uint8Array>}
 */
async function readZipEntry(zip, wanted) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // The end-of-directory record is the last thing in the file, followed only by
  // a comment of at most 65535 bytes, so it is searched for backwards over that
  // span and no further.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new DocxError("isn't a Word document - it isn't a .docx file inside, whatever its name says");

  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at === 0xffffffff || entries === 0xffff) {
    throw new DocxError("is packed in a way this can't read - save it again from Word, or attach a PDF");
  }

  const nameOf = (offset, length) => new TextDecoder().decode(zip.subarray(offset, offset + length));
  for (let n = 0; n < entries; n++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== SIG_DIRECTORY_ENTRY) {
      throw new DocxError("is damaged - its list of contents can't be read");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = nameOf(at + 46, nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;

    if (flags & FLAG_ENCRYPTED) throw new DocxError("is password-protected - remove the password in Word, or attach a PDF");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new DocxError("is packed in a way this can't read - save it again from Word, or attach a PDF");
    }
    if (size > MAX_XML_BYTES) throw new DocxError("holds far more text than a resume - attach a PDF instead");
    if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== SIG_LOCAL_HEADER) {
      throw new DocxError("is damaged - its contents can't be found where its list says they are");
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > zip.length) throw new DocxError("is damaged - it ends partway through");
    const data = zip.subarray(dataStart, dataStart + compressedSize);

    if (method === METHOD_STORED) return data;
    if (method !== METHOD_DEFLATE) {
      throw new DocxError("is packed in a way this can't read - save it again from Word, or attach a PDF");
    }
    return inflate(data);
  }
  throw new DocxError("isn't a Word document - it has no document text inside");
}

/**
 * Inflate raw deflate data, refusing once the output passes MAX_XML_BYTES
 * rather than trusting the size the zip declares.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function inflate(data) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_XML_BYTES) {
        await reader.cancel();
        throw new DocxError("holds far more text than a resume - attach a PDF instead");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof DocxError) throw err;
    throw new DocxError("is damaged - its text can't be unpacked");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/**
 * The text of a document.xml, by the plan's procedure.
 *
 * - Text comes only from `w:t`. Deleted tracked changes (`w:delText`) and field
 *   codes (`w:instrText`) are not the document's text.
 * - `w:tab` is a tab, `w:br` and `w:cr` a line break.
 * - A paragraph ends a line. Inside a table cell it ends with a space instead,
 *   so a cell holding two paragraphs stays one cell.
 * - A cell ends with a tab and a row with a line break, so a row reads as one
 *   tab-separated line.
 * - A paragraph's tab stops (`w:tab` inside `w:tabs`) are layout, not text.
 * - Word writes a text box twice, once for current readers (`mc:Choice`) and
 *   again for old ones (`mc:Fallback`). Only the first is read, or a resume's
 *   sidebar would appear twice.
 *
 * @param {string} xml
 * @returns {string}
 */
export function documentText(xml) {
  let out = "";
  let inText = false;
  let cellDepth = 0;
  let tabStopsDepth = 0;
  let fallbackDepth = 0;
  const tag = /<(\/?)([A-Za-z]+:[A-Za-z]+)\b[^>]*?(\/?)>|([^<]+)|<[^>]*>/g;
  for (const m of xml.matchAll(tag)) {
    const [, closing, name, selfClosing, text] = m;
    if (text !== undefined) {
      if (inText && fallbackDepth === 0) out += decodeEntities(text);
      continue;
    }
    if (!name) continue;
    if (name === "mc:Fallback") {
      if (!closing && !selfClosing) fallbackDepth++;
      else if (closing) fallbackDepth = Math.max(0, fallbackDepth - 1);
      continue;
    }
    if (fallbackDepth > 0) continue;
    if (name === "w:tabs") {
      if (!closing && !selfClosing) tabStopsDepth++;
      else if (closing) tabStopsDepth = Math.max(0, tabStopsDepth - 1);
    } else if (name === "w:t") {
      inText = !closing && !selfClosing;
    } else if (name === "w:tab" && !closing && tabStopsDepth === 0) {
      out += "\t";
    } else if ((name === "w:br" || name === "w:cr") && !closing) {
      out += "\n";
    } else if (name === "w:tc") {
      if (!closing && !selfClosing) cellDepth++;
      else if (closing) {
        cellDepth = Math.max(0, cellDepth - 1);
        out = out.replace(/ +$/, "") + "\t";
      }
    } else if (name === "w:tr" && closing) {
      out = out.replace(/\t$/, "") + "\n";
    } else if (name === "w:p" && (closing || selfClosing)) {
      out += cellDepth > 0 ? " " : "\n";
    }
  }
  // Tidy the edges only: trailing spaces on a line and runs of blank lines. The
  // words and their order are left exactly as read.
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @param {string} text */
export function countWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * The text of a .docx and how many words it holds.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<{text: string, words: number}>} throws DocxError when it can't be read
 */
export async function docxText(bytes) {
  const zip = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const xml = new TextDecoder("utf-8").decode(await readZipEntry(zip, "word/document.xml"));
  const text = documentText(xml);
  return { text, words: countWords(text) };
}
