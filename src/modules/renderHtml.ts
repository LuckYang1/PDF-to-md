/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty */
// @ts-nocheck
const HTML_STYLE = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #f2f2f2;
    color: #111;
    font-family: "Times New Roman", "Noto Serif SC", "Songti SC", serif;
    line-height: 1.65;
  }
  main {
    box-sizing: border-box;
    width: min(100%, 920px);
    min-height: 100vh;
    margin: 0 auto;
    padding: 42px 56px 64px;
    background: #fff;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.35em 0 .55em; }
  p { margin: .75em 0; text-align: justify; }
  pre { overflow: auto; padding: 12px; background: #f6f6f6; border-radius: 4px; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  img { max-width: 100%; height: auto; display: block; margin: 12px auto; }
  figure { margin: 18px 0; text-align: center; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: .92em; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; vertical-align: top; }
  .table-wrap { overflow-x: auto; }
  .formula { text-align: center; white-space: pre-wrap; font-family: "Times New Roman", serif; }
  @media print {
    body { background: #fff; }
    main { width: auto; min-height: 0; margin: 0; padding: 0; }
    @page { margin: 20mm 18mm; }
  }
`;

type ImageMap = Record<string, string>;

export async function renderMarkdownZipToHTML(
  zipPath: string,
  title: string,
): Promise<string> {
  const zr = Components.classes[
    "@mozilla.org/libjar/zip-reader;1"
  ].createInstance(Components.interfaces.nsIZipReader);
  zr.open(Zotero.File.pathToFile(zipPath));
  try {
    const mdEntry = findMarkdownEntry(zr);
    if (!mdEntry) throw new Error("MinerU result zip did not contain markdown");
    const markdown = await readZipTextEntry(zr, mdEntry);
    if (!markdown.trim()) throw new Error("MinerU markdown was empty");
    const imageMap = await buildMarkdownImageMap(zr, markdown);
    return renderMarkdownToHTML(markdown, title, imageMap);
  } finally {
    zr.close();
  }
}

export function renderMarkdownToHTML(
  markdown: string,
  title: string,
  imageMap: ImageMap = {},
): string {
  const blocks = splitMarkdownBlocks(markdown);
  const body = blocks
    .map((block) => renderMarkdownBlock(block, imageMap))
    .filter(Boolean)
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <style>${HTML_STYLE}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>
`;
}

function splitMarkdownBlocks(markdown: string): string[] {
  const lines = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks: string[] = [];
  let index = 0;

  const push = (buffer: string[]) => {
    const block = buffer.join("\n").trim();
    if (block) blocks.push(block);
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const buffer = [line];
      index++;
      while (index < lines.length) {
        buffer.push(lines[index]);
        if (lines[index].trim().startsWith("```")) {
          index++;
          break;
        }
        index++;
      }
      push(buffer);
      continue;
    }

    if (trimmed === "$$") {
      const buffer = [line];
      index++;
      while (index < lines.length) {
        buffer.push(lines[index]);
        if (lines[index].trim() === "$$") {
          index++;
          break;
        }
        index++;
      }
      push(buffer);
      continue;
    }

    if (isMarkdownTableRow(trimmed)) {
      const buffer = [line];
      index++;
      while (index < lines.length && isMarkdownTableRow(lines[index].trim())) {
        buffer.push(lines[index]);
        index++;
      }
      push(buffer);
      continue;
    }

    if (isMarkdownImageLine(trimmed)) {
      const buffer = [line];
      index++;
      while (index < lines.length && isMarkdownImageLine(lines[index].trim())) {
        buffer.push(lines[index]);
        index++;
      }
      push(buffer);
      continue;
    }

    const buffer = [line];
    index++;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (
        !next ||
        next.startsWith("```") ||
        next === "$$" ||
        /^#{1,6}\s+/.test(next) ||
        isMarkdownTableRow(next) ||
        isMarkdownImageLine(next)
      ) {
        break;
      }
      buffer.push(lines[index]);
      index++;
    }
    push(buffer);
  }

  return blocks;
}

function renderMarkdownBlock(block: string, imageMap: ImageMap): string {
  const trimmed = block.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("```")) {
    const content = trimmed
      .replace(/^```[^\n]*\n?/, "")
      .replace(/\n?```\s*$/, "");
    return `<pre><code>${escapeHTML(content)}</code></pre>`;
  }

  if (/^\$\$[\s\S]*\$\$$/.test(trimmed)) {
    return `<div class="formula">${escapeHTML(trimmed.replace(/^\$\$|\$\$$/g, "").trim())}</div>`;
  }

  const heading = trimmed.match(/^(#{1,6})\s+([\s\S]+)$/);
  if (heading) {
    const level = Math.max(1, Math.min(heading[1].length, 6));
    return `<h${level}>${renderInline(heading[2].trim(), imageMap)}</h${level}>`;
  }

  if (isMarkdownTableBlock(trimmed)) {
    return renderMarkdownTable(trimmed, imageMap);
  }

  const images = extractMarkdownImages(trimmed);
  if (images.length) {
    return images
      .map((image) => renderMarkdownImage(image, imageMap))
      .join("\n");
  }

  const listItems = extractListItems(trimmed);
  if (listItems.length) {
    return `<ul>\n${listItems
      .map((item) => `<li>${renderInline(item, imageMap)}</li>`)
      .join("\n")}\n</ul>`;
  }

  const paragraph = trimmed.replace(/\s*\n\s*/g, " ");
  return `<p>${renderInline(paragraph, imageMap)}</p>`;
}

function renderMarkdownTable(block: string, imageMap: ImageMap): string {
  const rows = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(splitTableRow);

  if (!rows.length) return "";
  const hasSeparator =
    rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  const head = rows[0];
  const bodyRows = hasSeparator ? rows.slice(2) : rows.slice(1);

  const thead = `<thead><tr>${head
    .map((cell) => `<th>${renderInline(cell.trim(), imageMap)}</th>`)
    .join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td>${renderInline(cell.trim(), imageMap)}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderInline(text: string, imageMap: ImageMap): string {
  let out = escapeHTML(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (_m, alt, src) =>
    renderImageTag(
      unescapeHTML(alt),
      parseMarkdownImageDestination(src),
      imageMap,
    ),
  );
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label, href) =>
      `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${label}</a>`,
  );
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

function extractMarkdownImages(
  block: string,
): Array<{ alt: string; src: string }> {
  const images: Array<{ alt: string; src: string }> = [];
  const pattern = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block))) {
    images.push({
      alt: match[1],
      src: parseMarkdownImageDestination(match[2]),
    });
  }
  return images;
}

function renderMarkdownImage(
  image: { alt: string; src: string },
  imageMap: ImageMap,
): string {
  return `<figure>${renderImageTag(image.alt, image.src, imageMap)}</figure>`;
}

function renderImageTag(alt: string, src: string, imageMap: ImageMap): string {
  const resolved = imageMap[src] || src;
  return `<img src="${escapeAttribute(resolved)}" alt="${escapeAttribute(alt)}">`;
}

async function buildMarkdownImageMap(
  zipReader: nsIZipReader,
  markdown: string,
): Promise<ImageMap> {
  const imageMap: ImageMap = {};
  const seen = new Set<string>();
  const pattern = /!\[[^\]]*\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const ref = parseMarkdownImageDestination(match[1]);
    if (!ref || /^(?:https?:|data:|file:)/i.test(ref) || seen.has(ref))
      continue;
    seen.add(ref);
    const dataURL = await readZipImageDataURL(zipReader, ref);
    if (dataURL) imageMap[ref] = dataURL;
  }
  return imageMap;
}

async function readZipImageDataURL(
  zipReader: nsIZipReader,
  entry: string,
): Promise<string> {
  const resolvedEntry = resolveZipEntry(zipReader, entry);
  if (!resolvedEntry) return "";

  const stream = zipReader.getInputStream(resolvedEntry);
  const binaryStream = Components.classes[
    "@mozilla.org/binaryinputstream;1"
  ].createInstance(Components.interfaces.nsIBinaryInputStream);
  binaryStream.setInputStream(stream);

  const chunks: number[][] = [];
  let byteLength = 0;
  try {
    while (binaryStream.available() > 0) {
      const chunk = binaryStream.readByteArray(binaryStream.available());
      chunks.push(chunk);
      byteLength += chunk.length;
    }
  } finally {
    binaryStream.close();
    stream.close();
  }
  if (!byteLength) return "";

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const ext = (resolvedEntry.split(".").pop() || "png").toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "gif"
        ? "image/gif"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    let binary = "";
    const end = Math.min(i + chunkSize, bytes.length);
    for (let j = i; j < end; j++) {
      binary += String.fromCharCode(bytes[j]);
    }
    parts.push(binary);
  }
  return btoa(parts.join(""));
}

function findMarkdownEntry(zipReader: nsIZipReader): string {
  const entries: string[] = [];
  const zipEntries = zipReader.findEntries("*");
  while (zipEntries.hasMore()) {
    const entry = zipEntries.getNext();
    if (typeof entry !== "string") continue;
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.toLowerCase().endsWith(".md")) entries.push(entry);
  }
  return (
    entries.find((entry) => /(^|\/)(full|paper)\.md$/i.test(entry)) ||
    entries.find((entry) => !/(^|\/)__macosx\//i.test(entry)) ||
    ""
  );
}

async function readZipTextEntry(
  zipReader: nsIZipReader,
  entry: string,
): Promise<string> {
  const stream = zipReader.getInputStream(entry);
  return String(await Zotero.File.getContentsAsync(stream, "utf-8"));
}

function resolveZipEntry(zipReader: nsIZipReader, entry: string): string {
  const candidates = [normalizeZipPath(entry)];
  try {
    const decoded = decodeURIComponent(candidates[0]);
    if (decoded !== candidates[0]) candidates.push(decoded);
  } catch {}

  const entries = zipReader.findEntries("*");
  while (entries.hasMore()) {
    const current = entries.getNext();
    if (typeof current !== "string") continue;
    const normalizedCurrent = current.replace(/\\/g, "/");
    if (
      candidates.some(
        (candidate) =>
          normalizedCurrent === candidate ||
          normalizedCurrent.endsWith(`/${candidate}`),
      )
    ) {
      return current;
    }
  }
  return "";
}

function normalizeZipPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function parseMarkdownImageDestination(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^['"]|['"]$/g, "");
}

function isMarkdownTableRow(line: string): boolean {
  return /^\|.+\|$/.test(line);
}

function isMarkdownTableBlock(block: string): boolean {
  const lines = block.split("\n").map((line) => line.trim());
  return lines.length >= 2 && lines.every(isMarkdownTableRow);
}

function isMarkdownImageLine(line: string): boolean {
  return /^!\[[^\]]*\]\([^)]+\)\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|");
}

function extractListItems(block: string): string[] {
  const lines = block.split("\n").map((line) => line.trim());
  if (!lines.every((line) => /^([-*+]|\d+\.)\s+/.test(line))) return [];
  return lines.map((line) => line.replace(/^([-*+]|\d+\.)\s+/, ""));
}

function escapeHTML(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHTML(value).replace(/"/g, "&quot;");
}

function unescapeHTML(value: string): string {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
