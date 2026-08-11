/** Pure helpers for Chandao image handling (design §9). No I/O — all side
 *  effects live in the runner. Chandao embeds images as
 *  `<img src="/index.php?m=file&f=read&t=png&fileID=NNN">` (session-bound,
 *  fragile). The Importer downloads each `fileID` via the REST file endpoint
 *  and rewrites the `src` to a local relative path so the work item renders
 *  offline and travels with it into git. */

const FILE_ID_RE = /fileID=(\d+)/g;

/** Extract every unique Chandao `fileID=NNN` (in order of first appearance). */
export function extractChandaoFileIds(html: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of html.matchAll(FILE_ID_RE)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Rewrite every `<img src="…fileID=NNN…">` (single or double quoted) to point
 * at a local relative path `attachments/chandao-<id>.<ext>`. `extOf` maps a
 * fileId to its extension (obtained after downloading). Non-Chandao srcs are
 * left untouched.
 */
export function rewriteChandaoImageSources(
  html: string,
  extOf: (fileId: string) => string,
  prefix = "chandao",
): string {
  return html.replace(
    /src=(["'])([^"']*fileID=(\d+)[^"']*)\1/gi,
    (full, quote: string, _url: string, id: string) => {
      const ext = extOf(id) || "bin";
      return `src=${quote}attachments/${prefix}-${id}.${ext}${quote}`;
    },
  );
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38]); // "GIF8"
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF" (webp container)

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  // Compare only the leading signature bytes that are present — magic-byte
  // sniffing only cares about the signature, and callers/tests may pass
  // truncated buffers. A real image file is always longer than any prefix.
  const len = Math.min(bytes.length, prefix.length);
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Detect an image extension from magic bytes; falls back to a content-type
 * string (e.g. "image/png"), then to "bin". Magic bytes are primary because
 * Chandao's file endpoint returns the binary stream directly.
 */
export function detectImageExt(bytes: Buffer, contentType?: string): string {
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPG)) return "jpg";
  if (startsWith(bytes, GIF)) return "gif";
  // WEBP: RIFF....WEBP
  if (startsWith(bytes, WEBP) && bytes.length >= 12 && bytes.slice(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  if (contentType) {
    const match = contentType.toLowerCase().match(/image\/([\w.+-]+)/);
    if (match) return match[1] === "jpeg" ? "jpg" : match[1];
  }
  return "bin";
}
