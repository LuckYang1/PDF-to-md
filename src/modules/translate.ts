import { getPref } from "../utils/prefs";

export type TranslateServiceName = "custom" | "deepseek" | "tencent";
export type TranslateMode = "bilingual" | "translated";

export type TranslateServiceConfig = {
  name: TranslateServiceName;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TranslationWindow = {
  fetch: typeof fetch;
  AbortController?: typeof AbortController;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

export type MarkdownChunk = {
  text: string;
  translatable: boolean;
  /**
   * Paragraph-level pieces (heading / paragraph / table, with their
   * trailing whitespace) of a translatable chunk, in order. The
   * concatenation equals `text`. Used for paragraph-aligned bilingual
   * output.
   */
  units?: string[];
};

type MarkdownUnit = MarkdownChunk;

/**
 * Built-in presets for OpenAI-compatible translation services.
 * Users only need to fill in their own API key.
 */
export const TRANSLATE_PRESETS: Record<
  Exclude<TranslateServiceName, "custom">,
  {
    baseUrl: string;
    model: string;
    label: string;
    /** Recommended chunk size in characters for this service. */
    recommendedChunkSize: number;
    /**
     * Hard upper bound for a chunk. A paragraph larger than the
     * recommended size but still below this limit is kept whole
     * (paragraph-adaptive chunking) instead of being split.
     */
    maxChunkSize: number;
  }
> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    // Current API name for DeepSeek V4.1 Flash ("deepseek-chat" is retired)
    model: "deepseek-flash",
    label: "DeepSeek",
    recommendedChunkSize: 6000,
    maxChunkSize: 12000,
  },
  tencent: {
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    model: "hy-mt2-pro",
    label: "Tencent Hy-MT2-Pro",
    // hy-mt2-pro accepts ~4K input tokens; keep headroom for the prompt
    recommendedChunkSize: 2500,
    maxChunkSize: 3500,
  },
};

/** Default chunk size for the custom service. */
export const CUSTOM_CHUNK_SIZE = 2500;

/**
 * Recommended chunk size for a service: DeepSeek's 64K context allows
 * larger chunks (fewer requests); Tencent Hy-MT2-Pro is capped by its
 * ~4K input limit.
 */
export function recommendedChunkSize(service?: string): number {
  const name = normalizeService(service);
  return name === "custom"
    ? CUSTOM_CHUNK_SIZE
    : TRANSLATE_PRESETS[name].recommendedChunkSize;
}

/**
 * Hard chunk limit for a service: paragraphs up to this size are kept
 * whole. For the custom service the user-configured chunk size is the
 * limit (the endpoint's capabilities are unknown).
 */
export function maxChunkSize(service?: string, chunkSize?: number): number {
  const name = normalizeService(service);
  if (name === "custom") {
    return Math.max(200, Math.floor(chunkSize ?? 0) || 2500);
  }
  const preset = TRANSLATE_PRESETS[name].maxChunkSize;
  return chunkSize ? Math.max(preset, Math.floor(chunkSize)) : preset;
}

const CHAT_TIMEOUT = 120000;
const CHAT_ATTEMPTS = 2;
const CHAT_RETRY_DELAY = 5000;

/**
 * Read the translation service config from preferences.
 * Presets contribute a fixed base URL and model; the key
 * (and, for "custom", URL/model as well) comes from user prefs.
 */
export function getServiceConfig(service?: string): TranslateServiceConfig {
  const name = normalizeService(service);
  if (name === "deepseek") {
    return {
      name,
      baseUrl: TRANSLATE_PRESETS.deepseek.baseUrl,
      model: TRANSLATE_PRESETS.deepseek.model,
      apiKey: String(getPref("translateDeepseekKey") || "").trim(),
    };
  }
  if (name === "tencent") {
    return {
      name,
      baseUrl: TRANSLATE_PRESETS.tencent.baseUrl,
      model: TRANSLATE_PRESETS.tencent.model,
      apiKey: String(getPref("translateTencentKey") || "").trim(),
    };
  }
  return {
    name: "custom",
    baseUrl: String(getPref("translateCustomBaseUrl") || "")
      .trim()
      .replace(/\/+$/, ""),
    apiKey: String(getPref("translateCustomKey") || "").trim(),
    model: String(getPref("translateCustomModel") || "").trim(),
  };
}

function normalizeService(service?: string): TranslateServiceName {
  const value = String(service || getPref("translateService") || "");
  if (value === "deepseek" || value === "tencent") return value;
  return "custom";
}

/**
 * Validate a service config. Returns "" when usable,
 * otherwise a short English error message for the log.
 */
export function validateServiceConfig(cfg: TranslateServiceConfig): string {
  if (!cfg.baseUrl) return "API base URL is empty";
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    return "API base URL must start with http:// or https://";
  }
  if (!cfg.apiKey) return "API key is empty";
  if (!cfg.model) return "model name is empty";
  return "";
}

function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

function fenceMarkerOf(line: string): string {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  return match ? match[1] : "";
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return (
    !!marker &&
    trimmed.length >= marker.length &&
    trimmed.startsWith(marker[0].repeat(3)) &&
    /^(`{3,}|~{3,})\s*$/.test(trimmed) &&
    trimmed[0] === marker[0]
  );
}

function isBareMathDelimiter(line: string): boolean {
  return line.trim() === "$$";
}

function isDisplayMathStart(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("$$") &&
    (isBareMathDelimiter(line) || !line.trimEnd().endsWith("$$"))
  );
}

function isInlineOnlyDisplayMath(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("$$") &&
    trimmed.endsWith("$$") &&
    trimmed.length > "$$$$".length
  );
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

function isStructuralLine(line: string): boolean {
  return (
    isBlankLine(line) ||
    !!fenceMarkerOf(line) ||
    isDisplayMathStart(line) ||
    isInlineOnlyDisplayMath(line) ||
    isTableLine(line) ||
    isHeadingLine(line)
  );
}

/**
 * Split markdown into ordered units (paragraphs, headings, tables,
 * fenced code blocks, math blocks, whitespace runs) so that the
 * concatenation of all unit texts reproduces the input exactly.
 */
function splitIntoUnits(md: string): MarkdownUnit[] {
  const units: MarkdownUnit[] = [];
  const lines = md.split(/(?<=\n)/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlankLine(line)) {
      let blanks = "";
      while (i < lines.length && isBlankLine(lines[i])) {
        blanks += lines[i];
        i++;
      }
      if (units.length > 0) {
        units[units.length - 1].text += blanks;
      } else {
        units.push({ text: blanks, translatable: false });
      }
      continue;
    }

    const marker = fenceMarkerOf(line);
    if (marker) {
      let text = line;
      i++;
      while (i < lines.length && !isClosingFence(lines[i], marker)) {
        text += lines[i];
        i++;
      }
      if (i < lines.length) {
        text += lines[i];
        i++;
      }
      units.push({ text, translatable: false });
      continue;
    }

    if (isInlineOnlyDisplayMath(line)) {
      units.push({ text: line, translatable: false });
      i++;
      continue;
    }

    if (isDisplayMathStart(line)) {
      let text = line;
      i++;
      while (i < lines.length && !lines[i].trimEnd().endsWith("$$")) {
        text += lines[i];
        i++;
      }
      if (i < lines.length) {
        text += lines[i];
        i++;
      }
      units.push({ text, translatable: false });
      continue;
    }

    if (isTableLine(line)) {
      let text = "";
      while (i < lines.length && isTableLine(lines[i])) {
        text += lines[i];
        i++;
      }
      units.push({ text, translatable: true });
      continue;
    }

    if (isHeadingLine(line)) {
      units.push({ text: line, translatable: true });
      i++;
      continue;
    }

    let text = "";
    while (i < lines.length && !isStructuralLine(lines[i])) {
      text += lines[i];
      i++;
    }
    units.push({ text, translatable: true });
  }

  return units;
}

/**
 * Subdivide an oversized sentence at progressively weaker boundaries:
 * secondary punctuation, then whitespace (words stay whole), and only
 * as a last resort a raw character cut — so a translatable sentence is
 * essentially never truncated mid-sentence.
 */
function subdividePiece(piece: string, limit: number): string[] {
  if (piece.length <= limit) return [piece];
  const out: string[] = [];
  for (const seg of piece.split(/(?<=[,、;:，；：])/)) {
    if (seg.length <= limit) {
      out.push(seg);
      continue;
    }
    for (const word of seg.split(/(?<=\s)/)) {
      if (word.length <= limit) {
        out.push(word);
        continue;
      }
      for (let i = 0; i < word.length; i += limit) {
        out.push(word.slice(i, i + limit));
      }
    }
  }
  return out;
}

/**
 * Split a unit longer than `limit` into sentence-aligned parts. The
 * concatenation of all parts reproduces the original text exactly.
 */
function splitLongUnit(unit: MarkdownUnit, limit: number): MarkdownUnit[] {
  if (unit.text.length <= limit || !unit.translatable) return [unit];
  const parts: string[] = [];
  let buffer = "";
  for (const sentence of unit.text.split(/(?<=[。．！？!?；;])/)) {
    for (const seg of subdividePiece(sentence, limit)) {
      if (buffer && buffer.length + seg.length > limit) {
        parts.push(buffer);
        buffer = "";
      }
      buffer += seg;
    }
  }
  if (buffer) parts.push(buffer);
  return parts.map((text) => ({ text, translatable: true }));
}

/**
 * Block-aware chunking: never send fenced code blocks or LaTeX math
 * to the translation model, never split a table or a paragraph group.
 * Chunks accumulate up to `chunkSize` (the recommended/target size);
 * a single paragraph larger than the target but within `maxChunkSize`
 * is kept whole (paragraph-adaptive), and only units above
 * `maxChunkSize` are split — at sentence boundaries whenever possible
 * (important for services such as hy-mt2-pro with a 4K input limit).
 */
export function splitMarkdownIntoChunks(
  md: string,
  chunkSize: number,
  maxChunkLimit = 0,
): MarkdownChunk[] {
  const size = Math.max(200, Math.floor(chunkSize) || 2500);
  const limit = Math.max(size, Math.floor(maxChunkLimit) || size);
  const units = splitIntoUnits(md).flatMap((unit) =>
    splitLongUnit(unit, limit),
  );
  const chunks: MarkdownChunk[] = [];
  let current: MarkdownUnit[] = [];
  let currentLength = 0;
  let currentTranslatable: boolean | null = null;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      text: current.map((unit) => unit.text).join(""),
      translatable: currentTranslatable === true,
      units:
        currentTranslatable === true
          ? current.map((unit) => unit.text)
          : undefined,
    });
    current = [];
    currentLength = 0;
    currentTranslatable = null;
  };

  for (const unit of units) {
    if (
      currentTranslatable !== null &&
      unit.translatable !== currentTranslatable
    ) {
      flush();
    }
    if (currentLength > 0 && currentLength + unit.text.length > size) {
      flush();
    }
    currentTranslatable = unit.translatable;
    current.push(unit);
    currentLength += unit.text.length;
  }
  flush();
  return chunks;
}

/**
 * Build chat messages instructing the model to act as a document
 * translation engine while preserving the markdown structure.
 */
export function buildTranslationMessages(
  text: string,
  targetLang: string,
): ChatMessage[] {
  const lang = targetLang || "Chinese";
  return [
    {
      role: "system",
      content:
        `You are a professional document translation engine. ` +
        `Translate the user's Markdown text into ${lang}. Rules:\n` +
        `1. Output ONLY the translation. No explanations, notes, or delimiters.\n` +
        `2. Preserve the Markdown structure exactly: heading levels, lists, ` +
        `tables, blockquotes, links, and line breaks.\n` +
        `3. Keep code blocks, inline code, LaTeX formulas ($...$, $$...$$), ` +
        `URLs, image references, and HTML tags unchanged.\n` +
        `4. Use standard ${lang} terminology for technical terms.`,
    },
    {
      role: "user",
      content: `Translate the following Markdown into ${lang}:\n\n${text.trim()}`,
    },
  ];
}

function errorMessageText(e: unknown): string {
  return String((e as any)?.message || e || "Unknown error");
}

/**
 * Marker prefix used to keep paragraph alignment in batch mode:
 * each paragraph is sent as "[P1] text", "[P2] text", ... and the
 * model is asked to keep the marker at the start of the translated
 * paragraph so the local code can split the reply back into
 * paragraphs. "[P1]" is deliberately distinct from markdown link
 * references ("[1]: ...") and ordered lists ("1. ...").
 */
const PARAGRAPH_MARKER = /\[P(\d{1,3})\][ \t]*/g;

/**
 * Build a batch request: multiple paragraphs travel together (better
 * context for the model, fewer requests), each tagged with a [Pn]
 * marker that must be echoed back so the reply can be split locally
 * into paragraph-aligned translations.
 */
export function buildBatchTranslationMessages(
  paragraphs: string[],
  targetLang: string,
): ChatMessage[] {
  const lang = targetLang || "Chinese";
  const body = paragraphs
    .map((text, index) => `[P${index + 1}] ${text.trim()}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        `You are a professional document translation engine. ` +
        `Translate the user's Markdown paragraphs into ${lang}. Rules:\n` +
        `1. Echo each paragraph's [Pn] marker at the very start of its ` +
        `translation, one translated paragraph per marker, same order, ` +
        `same count. Do not merge, split, add, or drop paragraphs.\n` +
        `2. Output ONLY the marked translations. No explanations or ` +
        `extra delimiters.\n` +
        `3. Preserve the Markdown structure exactly: heading levels, ` +
        `lists, tables, links, and line breaks.\n` +
        `4. Keep code blocks, inline code, LaTeX formulas ($...$, ` +
        `$$...$$), URLs, image references, and HTML tags unchanged.\n` +
        `5. Use standard ${lang} terminology for technical terms.`,
    },
    {
      role: "user",
      content:
        `Translate the following ${paragraphs.length} Markdown ` +
        `paragraphs into ${lang}, keeping each [Pn] marker:\n\n${body}`,
    },
  ];
}

/**
 * Split a batch reply back into per-paragraph translations using the
 * [Pn] markers. Returns null when the markers are missing or
 * incomplete (callers then fall back to chunk-level alignment).
 */
export function parseBatchTranslation(
  reply: string,
  count: number,
): string[] | null {
  if (!count) return null;
  const cleaned = stripResponseFence(reply);
  PARAGRAPH_MARKER.lastIndex = 0;
  const matches = [...cleaned.matchAll(PARAGRAPH_MARKER)];
  if (matches.length < count) return null;
  const results = new Array<string | null>(count).fill(null);
  for (let i = 0; i < matches.length; i++) {
    const index = Number(matches[i][1]) - 1;
    if (index < 0 || index >= count) continue;
    const end = i + 1 < matches.length ? matches[i + 1].index : undefined;
    const body = cleaned.slice(matches[i].index! + matches[i][0].length, end);
    const text = body.trim();
    if (text) results[index] = text;
  }
  return results.every((text) => text !== null) ? (results as string[]) : null;
}

function isRetryableError(e: unknown): boolean {
  const message = errorMessageText(e);
  return (
    /HTTP (429|5\d\d)/.test(message) || /timed out|abort|network/i.test(message)
  );
}

function delay(win: TranslationWindow, ms: number): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}

async function postChatCompletion(
  url: string,
  cfg: TranslateServiceConfig,
  messages: ChatMessage[],
  win: TranslationWindow,
  timeout: number,
): Promise<string> {
  const controller = win.AbortController ? new win.AbortController() : null;
  const timer = controller
    ? win.setTimeout(() => controller.abort(), timeout)
    : null;
  let resp: Response;
  try {
    resp = await win.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    throw new Error(`request failed (${errorMessageText(e)})`, { cause: e });
  } finally {
    if (timer !== null) win.clearTimeout(timer);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const data: any = await resp.json();
      detail = String(
        data?.error?.message || data?.message || data?.detail || "",
      );
    } catch {
      // non-JSON error body
    }
    throw new Error(
      `HTTP ${resp.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    );
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error("HTTP 200: invalid JSON response");
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("model returned empty content");
  }
  return content;
}

/**
 * POST one chat-completion request to an OpenAI-compatible endpoint.
 * Retries once on rate-limit / server / network errors.
 */
export async function chatCompletion(
  cfg: TranslateServiceConfig,
  messages: ChatMessage[],
  win: TranslationWindow,
  timeout = CHAT_TIMEOUT,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CHAT_ATTEMPTS; attempt++) {
    try {
      return await postChatCompletion(url, cfg, messages, win, timeout);
    } catch (e) {
      lastError = e;
      if (attempt >= CHAT_ATTEMPTS || !isRetryableError(e)) throw e;
      await delay(win, CHAT_RETRY_DELAY);
    }
  }
  throw lastError;
}

/**
 * Remove a possible markdown code fence some models wrap around
 * their answer.
 */
export function stripResponseFence(text: string): string {
  let value = text.trim();
  const fenced = value.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (fenced) value = fenced[1];
  return value.trim();
}

/**
 * Prefix every line with "> " so the translation is rendered as a
 * blockquote below the original paragraph.
 */
export function wrapBlockquote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function splitTrailingWhitespace(text: string): [string, string] {
  const match = text.match(/^([\s\S]*?)(\s*)$/);
  return [match ? match[1] : text, match ? match[2] : ""];
}

/**
 * Bilingual output: keep the original text, append the translation
 * as a blockquote, then restore the original trailing whitespace.
 */
export function assembleBilingual(
  original: string,
  translated: string,
): string {
  const [body, trail] = splitTrailingWhitespace(original);
  return `${body}\n\n${wrapBlockquote(translated)}${trail}`;
}

/**
 * Translated-only output: replace the original body but keep the
 * original trailing whitespace (blank lines between blocks).
 */
export function assembleTranslated(
  original: string,
  translated: string,
): string {
  const [, trail] = splitTrailingWhitespace(original);
  return `${translated.trim()}${trail}`;
}

export type TranslateMarkdownOptions = {
  cfg: TranslateServiceConfig;
  targetLang: string;
  mode: TranslateMode;
  chunkSize: number;
  /**
   * Hard chunk limit for paragraph-adaptive chunking: paragraphs up to
   * this size are kept whole. Defaults to `chunkSize`.
   */
  maxChunkSize?: number;
  onProgress?: (done: number, total: number) => void;
};

/**
 * Translate a markdown document chunk by chunk. Fenced code blocks
 * and LaTeX math blocks are passed through untouched. Chunks are
 * processed serially, consistent with the conversion queue.
 *
 * Each translatable chunk is sent as one batched request containing
 * all of its paragraphs (better context, fewer requests); the reply
 * is split back into paragraphs via [Pn] markers so the bilingual
 * output can interleave one original paragraph with its translation.
 * When the markers cannot be parsed, the chunk falls back to
 * chunk-level alignment so no content is ever lost.
 */
export async function translateMarkdown(
  markdown: string,
  opts: TranslateMarkdownOptions,
  win: TranslationWindow,
): Promise<string> {
  const chunks = splitMarkdownIntoChunks(
    markdown,
    opts.chunkSize,
    opts.maxChunkSize ?? 0,
  );
  const total = chunks.filter((chunk) => chunk.translatable).length;
  if (!total) return markdown;

  let done = 0;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.translatable) {
      parts.push(chunk.text);
      continue;
    }
    const units = chunk.units?.length ? chunk.units : [chunk.text];
    const reply = await chatCompletion(
      opts.cfg,
      buildBatchTranslationMessages(units, opts.targetLang),
      win,
    );
    const translated = stripResponseFence(reply);
    done++;
    try {
      opts.onProgress?.(done, total);
    } catch {
      // progress callback must never break the translation
    }
    const perUnit = parseBatchTranslation(reply, units.length);
    if (perUnit) {
      parts.push(
        perUnit
          .map((text, index) =>
            opts.mode === "bilingual"
              ? assembleBilingual(units[index], text)
              : assembleTranslated(units[index], text),
          )
          .join(""),
      );
    } else {
      parts.push(
        opts.mode === "bilingual"
          ? assembleBilingual(chunk.text, translated)
          : assembleTranslated(chunk.text, translated),
      );
    }
  }
  return parts.join("");
}
