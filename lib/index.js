/**
 * dsh-exa — Exa search and page reading for DeepSeek Harness.
 *
 * Two halves:
 *
 * - **Providers** registered on `ctx.web`, so `web_search` and `web_fetch` run
 *   through Exa with no change to the tools the model already knows.
 * - **Six tools** (`exa_search`, `exa_contents`, `exa_answer`, `exa_similar`,
 *   `exa_code_context`, `exa_research`) carrying the parameters `web_search`
 *   cannot: filters, content options, synthesis, similarity and the Agent API.
 *
 * An Exa API key is optional. Without one the plugin runs against Exa's hosted
 * MCP server, which needs no account; capabilities that server lacks say so
 * instead of degrading silently.
 *
 * @module dsh-exa
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebError } from "@deepseek-ai/dsh-web";
import { DEFAULT_BASE_URL, DEFAULT_MCP_URL, ExaClient, KEY_REF, transportError, transportSignal } from "./exa.js";

export const name = "web-exa";
export const inject = ["web", "tools", "systemPrompt"];

/** Provider ids; both are `exa` so one patch line selects both. */
const PROVIDER_ID = "exa";
/** Render cap for one tool result, matching `web_fetch`'s own output ceiling. */
const MAX_RENDER_CHARS = 200000;
/** Agent run states after which polling stops. */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Settings. Every field a user may change from the Plugins page is `.volatile()`
 * and flat: the settings form addresses one field per path segment, and a live
 * field applies to the next request instead of remounting the plugin.
 */
export const Config = z.object({
  apiKey: z.string().role("secret").volatile().description("Literal Exa API key. Prefer the credentials plane: the Plugins page writes it there."),
  apiKeyEnv: z.string().default(KEY_REF).volatile().description("Credential reference resolved for the Exa API key."),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile().description("Exa REST base URL."),
  mcpURL: z.string().default(DEFAULT_MCP_URL).volatile().description("Exa hosted MCP endpoint used when no key resolves."),
  timeoutMs: z.natural().default(30000).volatile().description("Per-request timeout in milliseconds."),

  searchType: z.string().default("auto").volatile().description("Search mode for web_search: auto, lite, deep-lite, deep, instant or fast."),
  searchCategory: z.string().volatile().description("Restrict web_search to one Exa category."),
  searchIncludeDomains: z.array(z.string()).volatile().description("Domains web_search may return."),
  searchExcludeDomains: z.array(z.string()).volatile().description("Domains web_search must not return."),
  searchMaxAgeHours: z.number().volatile().description("Cache freshness for web_search; 0 refetches, -1 uses the cache only."),
  searchHighlights: z.boolean().default(true).volatile().description("Ask Exa for query-relevant highlights; they become each source snippet."),
  searchText: z.boolean().default(false).volatile().description("Also request full page text for web_search results."),
  searchSummary: z.boolean().default(false).volatile().description("Also request a per-result summary for web_search results."),

  fetchMaxCharacters: z.natural().default(100000).volatile().description("Characters of page text web_fetch may return per URL."),
  fetchMaxAgeHours: z.number().volatile().description("Cache freshness for web_fetch; 0 refetches, -1 uses the cache only."),

  // The cheap tools that carry the capabilities a task needs from its first
  // turn — a cited answer, a multi-source research run, code examples — are
  // always on. The three expensive schemas stay behind `exa_tools`, because
  // web_search and web_fetch already cover plain lookup and fetching.
  toolSearch: z.boolean().default(false).volatile().description("Expose exa_search at startup instead of waiting for the model to open it."),
  toolContents: z.boolean().default(false).volatile().description("Expose exa_contents at startup instead of waiting for the model to open it."),
  toolAnswer: z.boolean().default(true).volatile().description("Expose exa_answer at startup."),
  toolSimilar: z.boolean().default(false).volatile().description("Expose exa_similar at startup instead of waiting for the model to open it."),
  toolCodeContext: z.boolean().default(true).volatile().description("Expose exa_code_context at startup."),
  toolResearch: z.boolean().default(true).volatile().description("Expose exa_research at startup."),

  researchTimeoutMs: z.natural().default(180000).description("Tool timeout for exa_research; changing it remounts the plugin."),
});

/** The connection settings, read fresh for one request. */
function connectionOf(config) {
  return {
    apiKey: config.apiKey.get() ?? "",
    apiKeyEnv: config.apiKeyEnv.get() ?? KEY_REF,
    baseURL: config.baseURL.get() ?? DEFAULT_BASE_URL,
    mcpURL: config.mcpURL.get() ?? DEFAULT_MCP_URL,
    timeoutMs: config.timeoutMs.get() ?? 30000,
  };
}

/** An optional list: an empty one means "do not send this filter at all". */
function listOf(value) {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/** An optional string: an empty one means "unset". */
function textOf(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Every live setting, read fresh. Providers and tools call this per request. */
function settingsOf(config) {
  return {
    ...connectionOf(config),
    searchType: config.searchType.get() ?? "auto",
    searchCategory: textOf(config.searchCategory.get()),
    searchIncludeDomains: listOf(config.searchIncludeDomains.get()),
    searchExcludeDomains: listOf(config.searchExcludeDomains.get()),
    searchMaxAgeHours: config.searchMaxAgeHours.get() ?? undefined,
    searchHighlights: config.searchHighlights.get() ?? true,
    searchText: config.searchText.get() ?? false,
    searchSummary: config.searchSummary.get() ?? false,
    fetchMaxCharacters: config.fetchMaxCharacters.get() ?? 100000,
    fetchMaxAgeHours: config.fetchMaxAgeHours.get() ?? undefined,
    toolSearch: config.toolSearch.get() ?? true,
    toolContents: config.toolContents.get() ?? true,
    toolAnswer: config.toolAnswer.get() ?? true,
    toolSimilar: config.toolSimilar.get() ?? true,
    toolCodeContext: config.toolCodeContext.get() ?? true,
    toolResearch: config.toolResearch.get() ?? true,
  };
}

// ── parameter schema pieces ─────────────────────────────────────────────────

/** Domain and publish-date filters shared by `/search` and `/findSimilar`. */
const filterParams = {
  includeDomains: {
    type: "array",
    items: { type: "string" },
    description: "Only return results from these domains or domain paths (up to 1200).",
  },
  excludeDomains: {
    type: "array",
    items: { type: "string" },
    description: "Never return results from these domains or domain paths (up to 1200).",
  },
  startPublishedDate: { type: "string", description: "ISO 8601 lower bound on the publish date." },
  endPublishedDate: { type: "string", description: "ISO 8601 upper bound on the publish date." },
};

/** Page-content options: `ContentsOptions` for `/search` and `/findSimilar`. */
const contentsParams = {
  text: {
    description:
      "Full page text. `true` for defaults, `false` to omit, or an object: {maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections}.",
    oneOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          maxCharacters: { type: "integer", description: "Cap on returned characters (1–1000000)." },
          includeHtmlTags: { type: "boolean", description: "Keep lightweight HTML tags instead of plain text." },
          verbosity: {
            type: "string",
            enum: ["compact", "standard", "full"],
            description: "How much surrounding page context to render; compact focuses on main content.",
          },
          includeSections: {
            type: "array",
            items: { type: "string", enum: ["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"] },
            description: "Best-effort: keep only these semantic page sections.",
          },
          excludeSections: {
            type: "array",
            items: { type: "string", enum: ["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"] },
            description: "Best-effort: drop these semantic page sections.",
          },
        },
      },
    ],
  },
  highlights: {
    description:
      "Query-relevant excerpts instead of whole pages. `true` for defaults, `false` to omit, or an object: {query, maxCharacters}.",
    oneOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Steer which passages get highlighted." },
          maxCharacters: { type: "integer", description: "Total highlight characters per URL (1–1000000)." },
        },
      },
    ],
  },
  summary: {
    type: "object",
    additionalProperties: false,
    description: "LLM-written summary per result.",
    properties: {
      query: { type: "string", description: "Focus the summary on this question." },
      schema: { type: "json", description: "JSON Schema the summary must satisfy, for structured output." },
    },
  },
  extras: {
    type: "object",
    additionalProperties: false,
    description: "Links and images harvested from each page.",
    properties: {
      links: { type: "integer", description: "URLs to return per page (0–1000)." },
      imageLinks: { type: "integer", description: "Image URLs to return per result (0–1000)." },
      richImageLinks: { type: "integer", description: "Image URLs with alt text (0–1000)." },
    },
  },
  maxAgeHours: {
    type: "integer",
    description: "Cache freshness in hours (-1…720): 0 always refetches, -1 always uses cache, omitted uses cache with a live fallback.",
  },
  livecrawlTimeout: { type: "integer", description: "Milliseconds allowed for a fresh fetch (1–90000)." },
  snapshotAsOf: {
    type: "string",
    description: "Return the page as it stood at this ISO 8601 instant, from stored versions only.",
  },
  subpages: { type: "integer", description: "Subpages to crawl per result (0–100); /contents only." },
  subpageTarget: {
    description: "Term(s) selecting which subpages to crawl; /contents only.",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
};

/** A `/search` or `/findSimilar` request body, minus the query/url and endpoint-specific fields. */
const contentsObject = {
  type: "object",
  additionalProperties: false,
  description: "What Exa returns for each result: text, highlights, summary, extras and freshness.",
  properties: contentsParams,
};

// ── rendering ───────────────────────────────────────────────────────────────

/** Join result bodies into one model-facing block, capped at {@link MAX_RENDER_CHARS}. */
function capRender(text) {
  if (text.length <= MAX_RENDER_CHARS) return text;
  return `${text.slice(0, MAX_RENDER_CHARS)}\n\n(Output truncated at ${MAX_RENDER_CHARS} characters; request a smaller maxCharacters or fewer results for the rest.)`;
}

/** Format Exa's `results[]` (search, contents, findSimilar) as readable text. */
function renderResults(value) {
  const results = Array.isArray(value?.results) ? value.results : [];
  if (results.length === 0) {
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    const failures = statuses.filter((entry) => entry?.status === "error");
    if (failures.length === 0) return "No results.";
    return `No results.\n\n${failures.map((entry) => `- ${entry.id}: ${entry.error?.tag ?? "failed"}`).join("\n")}`;
  }
  const blocks = results.map((result, index) => {
    const lines = [`[${index + 1}] ${result?.title ?? "(untitled)"}`, `    ${result?.url ?? "(no url)"}`];
    const meta = [
      result?.publishedDate === undefined ? undefined : `Published: ${result.publishedDate}`,
      result?.author === undefined || result.author === null ? undefined : `Author: ${result.author}`,
      result?.score === undefined ? undefined : `Score: ${result.score}`,
    ].filter((entry) => entry !== undefined);
    if (meta.length > 0) lines.push(`    ${meta.join(" | ")}`);
    const body =
      Array.isArray(result?.highlights) && result.highlights.length > 0
        ? result.highlights.join("\n")
        : (result?.summary ?? result?.text);
    if (typeof body === "string" && body.length > 0) {
      lines.push("", ...body.trim().split(/\r?\n/).map((line) => `    ${line}`));
    }
    const extras = result?.extras;
    if (extras !== null && typeof extras === "object") {
      if (Array.isArray(extras.links) && extras.links.length > 0) lines.push("", `    Links: ${extras.links.join(" ")}`);
      if (Array.isArray(extras.imageLinks) && extras.imageLinks.length > 0) lines.push(`    Images: ${extras.imageLinks.join(" ")}`);
    }
    return lines.join("\n");
  });
  return capRender(blocks.join("\n\n"));
}

/** Format one Agent run as readable text plus its grounding. */
function renderRun(run) {
  const lines = [`Run ${run?.id ?? "(unknown)"}: ${run?.status ?? "unknown"}${run?.stopReason ? ` (${run.stopReason})` : ""}`];
  const text = run?.output?.text;
  if (typeof text === "string" && text.length > 0) lines.push("", text);
  const structured = run?.output?.structured;
  if (structured !== null && structured !== undefined) lines.push("", "Structured output:", JSON.stringify(structured, null, 2));
  const grounding = Array.isArray(run?.output?.grounding) ? run.output.grounding : [];
  const citations = grounding.flatMap((entry) => (Array.isArray(entry?.citations) ? entry.citations : []));
  if (citations.length > 0) {
    lines.push("", "Sources:");
    for (const citation of citations) lines.push(`- [${citation?.title ?? citation?.url}](${citation?.url})`);
  }
  const cost = run?.costDollars?.total;
  if (typeof cost === "number") lines.push("", `Cost: $${cost}`);
  if (run?.status === "failed") lines.push("", "The run failed; create a new one or refine the query.");
  else if (run?.status !== "completed") lines.push("", `Still ${run?.status ?? "running"}; call exa_research again with runId "${run?.id ?? ""}" to continue waiting.`);
  return capRender(lines.join("\n"));
}

/** The render function every JSON-output tool shares. */
const renderJsonText = (textOf) => (_args, value) => [{ type: "text", text: capRender(textOf(value)) }];

// ── search provider ─────────────────────────────────────────────────────────

/** Build the `/search` body `web_search` sends, from live settings plus the request's own limits. */
function webSearchBody(settings, request) {
  const contents = {};
  if (settings.searchHighlights) contents.highlights = true;
  if (settings.searchText) contents.text = true;
  if (settings.searchSummary) contents.summary = {};
  if (settings.searchMaxAgeHours !== undefined) contents.maxAgeHours = settings.searchMaxAgeHours;
  return {
    query: request.query,
    type: settings.searchType,
    ...(request.maxResults === undefined ? {} : { numResults: request.maxResults }),
    ...(settings.searchCategory === undefined ? {} : { category: settings.searchCategory }),
    ...(settings.searchIncludeDomains === undefined ? {} : { includeDomains: settings.searchIncludeDomains }),
    ...(settings.searchExcludeDomains === undefined ? {} : { excludeDomains: settings.searchExcludeDomains }),
    contents,
  };
}

/** Turn Exa's result list into the seam's `sources[]`. */
function toSources(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map((result) => {
    const highlights = Array.isArray(result?.highlights) ? result.highlights : [];
    const snippet = highlights.length > 0 ? highlights.join("\n\n") : result?.summary ?? undefined;
    return {
      url: result?.url,
      ...(result?.title === undefined ? {} : { title: result.title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(result?.publishedDate === undefined ? {} : { publishedAt: result.publishedDate }),
    };
  });
}

class ExaSearchProvider {
  id = PROVIDER_ID;
  #client;
  #live;

  constructor(client, live) {
    this.#client = client;
    this.#live = live;
  }

  /** Both transports answer locally, so a search is always attemptable. */
  available() {
    return true;
  }

  async search(request, signal) {
    const payload = await this.#client.search(webSearchBody(this.#live(), request), signal);
    return { sources: toSources(payload), truncated: false };
  }
}

// ── fetch provider ──────────────────────────────────────────────────────────

/** Read one URL and shape it as the seam's fetch outcome. */
/**
 * Whether a URL points at this machine or a private network, which Exa will not
 * crawl. `localhost` and the RFC 1918 / loopback literals are the realistic
 * cases: a local dev server the user asks the model to read.
 */
export function isLocalUrl(raw) {
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.startsWith("[") || host.includes(":")) {
    // IPv6: only the loopback and link-local forms are worth special casing.
    const bare = host.replace(/^\[|\]$/g, "");
    return bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd");
  }
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const [a, b] = octets.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Read a local page directly. Exa is not in this path at all. */
async function directFetch(url, settings, signal) {
  const maxCharacters = settings.fetchMaxCharacters;
  let response;
  try {
    response = await fetch(url, { signal: transportSignal(signal, settings.timeoutMs), redirect: "follow" });
  } catch (error) {
    throw transportError(error, url, signal);
  }
  const raw = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(raw);
  const text = isHtml ? htmlToText(raw) : raw;
  const clipped = text.length > maxCharacters ? text.slice(0, maxCharacters) : text;
  return {
    url: response.url || url,
    statusCode: response.status,
    body: { kind: "text", content: clipped },
    truncated: text.length > clipped.length,
  };
}

/** Strip an HTML document down to readable text: enough for a local page, no dependency. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

class ExaFetchProvider {
  id = PROVIDER_ID;
  #client;
  #live;

  constructor(client, live) {
    this.#client = client;
    this.#live = live;
  }

  available() {
    return true;
  }

  async fetch(request, signal) {
    const settings = this.#live();
    // Exa refuses loopback and private addresses, and it is the wrong tool for
    // them anyway: a local page is one plain request away.
    if (isLocalUrl(request.url)) return directFetch(request.url, settings, signal);
    const maxCharacters = settings.fetchMaxCharacters;
    const contents = { text: { maxCharacters } };
    if (settings.fetchMaxAgeHours !== undefined) contents.maxAgeHours = settings.fetchMaxAgeHours;
    const payload = await this.#client.contents({ urls: [request.url], ...contents }, signal);
    const result = Array.isArray(payload?.results) ? payload.results[0] : undefined;
    if (result === undefined) {
      // Exa reports per-URL failures in `statuses[]` rather than by throwing.
      const status = Array.isArray(payload?.statuses) ? payload.statuses[0] : undefined;
      const tag = status?.error?.tag ?? "FETCH_FAILED";
      const code = status?.error?.httpStatusCode;
      return {
        url: request.url,
        statusCode: typeof code === "number" ? code : 502,
        body: { kind: "text", content: `Exa could not retrieve this URL (${tag}).` },
        truncated: false,
      };
    }
    const text = typeof result.text === "string" ? result.text : "";
    return {
      url: result.url ?? request.url,
      statusCode: 200,
      body: { kind: "text", content: text },
      truncated: text.length >= maxCharacters,
    };
  }
}

// ── extra tools ─────────────────────────────────────────────────────────────

/**
 * The advanced tools, in the order `exa_tools` lists them.
 *
 * Their schemas are expensive — `exa_search` alone is over 5 KB of JSON — and a
 * turn that only needs `web_search` should not pay for them. Only the ones a
 * session actually opens are registered, so the rest cost nothing.
 */
const TOOL_CATALOG = [
  {
    key: "search",
    tool: "exa_search",
    pin: "toolSearch",
    summary: "Search with filters: mode, category, domains, dates, per-result text/highlights/summary/extras, structured output.",
  },
  {
    key: "contents",
    tool: "exa_contents",
    pin: "toolContents",
    summary: "Fetch page text, highlights, summaries and subpages for several URLs at once.",
  },
  {
    key: "answer",
    tool: "exa_answer",
    pin: "toolAnswer",
    summary: "A cited answer instead of sources. Needs an API key.",
  },
  {
    key: "similar",
    tool: "exa_similar",
    pin: "toolSimilar",
    summary: "Pages similar to one you already have. Needs an API key.",
  },
  {
    key: "code",
    tool: "exa_code_context",
    pin: "toolCodeContext",
    summary: "Code and API examples for a library or SDK question.",
  },
  {
    key: "research",
    tool: "exa_research",
    pin: "toolResearch",
    summary: "A multi-source research run. Slow, and needs an API key.",
  },
];

const TOOL_KEYS = new Set(TOOL_CATALOG.map((entry) => entry.key));

/**
 * Register `exa_tools` plus whichever advanced tools are open, and keep that set
 * in step with the settings switches.
 *
 * `exa_tools` is registered once and never remounted: it is the tool the model
 * calls to open the others, so disposing it mid-call would be self-defeating.
 * Only the advanced tools are rebuilt.
 */
function registerTools(ctx, config, live, client) {
  const researchTimeoutMs = config.researchTimeoutMs;
  let disposers = [];
  /** Keys the model opened or closed itself, on top of the settings pins. */
  const opened = new Set();
  const closed = new Set();

  const activeKeys = () => {
    const enabled = live();
    const keys = new Set(opened);
    for (const entry of TOOL_CATALOG) if (enabled[entry.pin]) keys.add(entry.key);
    // A tool the model closed stays closed even when a switch pins it on: the
    // session knows what this task needs better than the default does.
    for (const key of closed) keys.delete(key);
    return keys;
  };

  const mount = () => {
    for (const dispose of disposers) dispose();
    disposers = [];
    registerActiveTools(live(), activeKeys(), client, researchTimeoutMs, (tool) => {
      disposers.push(ctx.tools.register(tool));
    });
  };

  ctx.tools.register(
    defineTool({
      name: "exa_tools",
      description:
        "Unlock Exa's remaining retrieval tools on demand. Call with no arguments to list them. Pass `enable` with any of search, contents, answer, similar, code or research to make those tools appear in your tool list; they stay available for the rest of the session, so open one only when the tools you already have cannot answer the question. Pass `disable` to drop one again.",
      parameters: {
        enable: {
          type: "array",
          items: { type: "string" },
          description: "Tool keys to open: search, contents, answer, similar, code, research.",
        },
        disable: {
          type: "array",
          items: { type: "string" },
          description: "Tool keys to close again.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => {
          const lines = [
            "## Exa advanced tools",
            "",
            ...value.available.map(
              (entry) => `- ${entry.open ? "**open**" : "closed"} — \`${entry.tool}\` (\`${entry.key}\`): ${entry.summary}`,
            ),
            "",
            value.active.length === 0
              ? "None open. Plain web_search and web_fetch are always available."
              : `Open now: ${value.active.map((key) => `\`${key}\``).join(", ")}.`,
          ];
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      execute: async (args) => {
        const wanted = Array.isArray(args?.enable) ? args.enable.filter((key) => TOOL_KEYS.has(key)) : [];
        const unwanted = Array.isArray(args?.disable) ? args.disable.filter((key) => TOOL_KEYS.has(key)) : [];
        let changed = false;
        for (const key of wanted) {
          const wasClosed = closed.delete(key);
          if (!opened.has(key)) {
            opened.add(key);
            changed = true;
          }
          changed ||= wasClosed;
        }
        for (const key of unwanted) {
          const wasOpen = opened.delete(key);
          closed.add(key);
          changed ||= wasOpen;
        }
        if (changed) mount();
        const active = activeKeys();
        return {
          active: TOOL_CATALOG.filter((entry) => active.has(entry.key)).map((entry) => entry.key),
          available: TOOL_CATALOG.map((entry) => ({
            key: entry.key,
            tool: entry.tool,
            summary: entry.summary,
            open: active.has(entry.key),
          })),
        };
      },
    }),
  );

  mount();
  ctx.effect(
    () =>
      ctx.on("loader/volatile-update", (paths) => {
        if (!paths.some(([head]) => typeof head === "string" && head.startsWith("tool"))) return;
        // A settings write is the user's decision about this set, so it also
        // clears whatever the model decided for itself.
        opened.clear();
        closed.clear();
        mount();
      }),
    "dsh-exa: tool switches",
  );
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose();
      disposers = [];
    },
    "dsh-exa: tool disposers",
  );
}

/** The advanced tools that are currently open, each with its full parameter surface. */
function registerActiveTools(enabled, active, client, researchTimeoutMs, register) {
  const timeoutMs = enabled.timeoutMs;

  if (active.has("search")) {
    register(
      defineTool({
        name: "exa_search",
        description:
          "Exa neural search with every documented filter: search mode, category, domains, publish dates, cache freshness, and per-result text/highlights/summary/extras. Use this instead of web_search when a search needs filters or richer content; use web_search for a plain multi-query lookup.",
        parameters: {
          query: { type: "string", required: true, description: "Natural-language description of the ideal page." },
          numResults: { type: "integer", description: "Results to return (1–100, default 10)." },
          type: {
            type: "string",
            description:
              "Search mode: auto (default, balanced), lite (cheap and fast, index-only, accepts only a subset of these parameters), deep-lite, deep (multi-step research with synthesis), instant or fast (legacy aliases of lite).",
          },
          category: {
            type: "string",
            description:
              "Focus on one data category: company, publication, news, personal site, financial report or people. Other strings act as hints. company and people reject publish-date filters; people also rejects excludeDomains.",
          },
          ...filterParams,
          objective: {
            type: "string",
            description:
              "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them.",
          },
          additionalQueries: {
            type: "array",
            items: { type: "string" },
            description: "Query variants (1–10) used alongside the main query by deep search modes.",
          },
          userLocation: {
            type: "string",
            description: "Two-letter ISO 3166-1 country code of the end user, to localize results.",
          },
          moderation: { type: "boolean", description: "Filter unsafe content out of the results." },
          systemPrompt: { type: "string", description: "Extra instructions guiding generated output or ranking." },
          outputSchema: {
            type: "json",
            description:
              "JSON Schema for synthesized output: {type:'text'|'object', description?, properties?, required?}. Object roots allow 10 properties and 2 nesting levels. Adds synthesis latency.",
          },
          contents: contentsObject,
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText(renderResults),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const { contents, ...rest } = args;
          const body = { ...rest, ...(contents === undefined ? {} : { contents }) };
          return client.search(body, exec.signal);
        },
        presentCall: (args) => ({ card: "generic", title: args.query, kind: "search", rawInput: args.query }),
      }),
    );
  }

  if (active.has("contents")) {
    register(
      defineTool({
        name: "exa_contents",
        description:
          "Read the content of known URLs or Exa document ids: full text, highlights, summaries, links and images, with cache-freshness and subpage controls. Use after exa_search or web_search when you have the URLs.",
        parameters: {
          urls: { type: "array", items: { type: "string" }, description: "URLs to read (1–100). Give this or ids, not both." },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Exa document ids from a previous search (1–100). Give this or urls, not both.",
          },
          ...contentsParams,
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText(renderResults),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if ((args.urls === undefined) === (args.ids === undefined)) {
            throw new WebError("exa_contents needs exactly one of `urls` or `ids`", "WEB_PROVIDER_ERROR");
          }
          return client.contents(args, exec.signal);
        },
        presentCall: (args) => ({
          card: "generic",
          title: args.urls?.[0] ?? args.ids?.[0] ?? "contents",
          kind: "fetch",
          rawInput: args.urls?.[0] ?? args.ids?.[0],
        }),
      }),
    );
  }

  if (active.has("answer")) {
    register(
      defineTool({
        name: "exa_answer",
        description:
          "Ask a question and get a cited answer synthesized from a live web search, optionally structured by a JSON Schema. Use when you want the answer rather than the sources.",
        parameters: {
          query: { type: "string", required: true, description: "The question or instruction to answer." },
          text: { type: "boolean", description: "Also return the full text of each cited source." },
          model: {
            type: "string",
            enum: ["exa", "exa-pro", "exa-research", "exa-fast"],
            description: "Answer model: exa (default), exa-pro (stronger), exa-research (deepest) or exa-fast.",
          },
          systemPrompt: { type: "string", description: "Extra instructions guiding the answer." },
          userLocation: { type: "string", description: "Two-letter ISO 3166-1 country code of the end user." },
          outputSchema: {
            type: "json",
            description: "JSON Schema (Draft 7) the answer must satisfy: {type, properties, required, description, additionalProperties}.",
          },
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText((value) => {
            const answer = typeof value?.answer === "string" ? value.answer : JSON.stringify(value?.answer, null, 2);
            const citations = Array.isArray(value?.citations) ? value.citations : [];
            const lines = [answer ?? "(no answer)"];
            if (citations.length > 0) {
              lines.push("", "Sources:");
              for (const citation of citations) lines.push(`- [${citation?.title ?? citation?.url}](${citation?.url})`);
            }
            return lines.join("\n");
          }),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return client.answer(args, exec.signal);
        },
        presentCall: (args) => ({ card: "generic", title: args.query, kind: "search", rawInput: args.query }),
      }),
    );
  }

  if (active.has("similar")) {
    register(
      defineTool({
        name: "exa_similar",
        description:
          "Find pages similar to one URL, with domain, date, category and content filters. Use to expand from a good page to its neighbours.",
        parameters: {
          url: { type: "string", required: true, description: "The page to find similar pages for." },
          numResults: { type: "integer", description: "Results to return (1–100, default 10)." },
          excludeSourceDomain: { type: "boolean", description: "Exclude results from the source URL's own domain." },
          category: {
            type: "string",
            description:
              "Focus on one data category: company, publication, news, personal site, financial report or people. With company or people, domain, URL, date and text filters are ignored.",
          },
          ...filterParams,
          contents: contentsObject,
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText(renderResults),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const { contents, ...rest } = args;
          const body = { ...rest, ...(contents === undefined ? {} : { contents }) };
          return client.findSimilar(body, exec.signal);
        },
        presentCall: (args) => ({ card: "generic", title: args.url, kind: "fetch", rawInput: args.url }),
      }),
    );
  }

  if (active.has("code")) {
    register(
      defineTool({
        name: "exa_code_context",
        description:
          "Find code examples, API documentation and programming solutions for a specific library or SDK question. Use for 'how do I use X' questions rather than general web search.",
        parameters: {
          query: {
            type: "string",
            required: true,
            description: "What you are looking for, specifically: 'Python requests library POST with JSON body', not 'python http'.",
          },
          numResults: { type: "integer", description: "Results to return (default 8)." },
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText((value) => (typeof value?.text === "string" ? value.text : renderResults(value))),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return client.codeContext(args.query, args.numResults, exec.signal);
        },
        presentCall: (args) => ({ card: "generic", title: args.query, kind: "search", rawInput: args.query }),
      }),
    );
  }

  if (active.has("research")) {
    register(
      defineTool({
        name: "exa_research",
        description:
          "Start an Exa Agent run for deep, multi-step research that returns a synthesized, cited answer, or check on one already started. Without runId it creates a run and waits up to waitSeconds; if the run is still going it returns the run id, and calling again with that runId resumes waiting. Use for questions that need many sources combined, not for a single lookup.",
        parameters: {
          query: { type: "string", description: "The research question. Required unless runId is given." },
          runId: { type: "string", description: "An existing run to wait on or read, instead of starting a new one." },
          effort: {
            type: "string",
            enum: ["minimal", "low", "medium", "high", "xhigh", "auto", "ultra"],
            description: "Reasoning effort and cost tier; auto (default) lets Exa choose, ultra is the most thorough.",
          },
          systemPrompt: { type: "string", description: "Extra instructions guiding the research." },
          outputSchema: {
            type: "json",
            description: "JSON Schema (draft-07, 2019-09 or 2020-12) the structured output must satisfy.",
          },
          previousRunId: { type: "string", description: "A completed run to continue from." },
          maxCostDollars: { type: "number", description: "Spending cap for auto or ultra runs ($1–$100)." },
          maxDurationSeconds: {
            type: "integer",
            description: "Wall-clock cap for ultra runs; Exa requires at least 300 and accepts at most 10800.",
          },
          waitSeconds: {
            type: "integer",
            description:
              "How long to wait for the run to finish before returning its id (default: as long as the tool timeout allows). A run that is still going comes back with its id; call again with that runId to keep waiting.",
          },
        },
        output: {
          schema: { type: "json" },
          render: renderJsonText(renderRun),
        },
        timeoutMs: researchTimeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const { waitSeconds, maxCostDollars, maxDurationSeconds, runId, ...rest } = args;
          // Exa rejects a budget outside these ranges with a bare 400, so the
          // bounds are checked here: the parameter DSL cannot express them.
          if (maxCostDollars !== undefined && !(maxCostDollars >= 1 && maxCostDollars <= 100)) {
            throw new WebError(`exa_research maxCostDollars must be between 1 and 100, got ${maxCostDollars}`, "WEB_PROVIDER_ERROR");
          }
          if (maxDurationSeconds !== undefined && !(maxDurationSeconds >= 300 && maxDurationSeconds <= 10800)) {
            throw new WebError(`exa_research maxDurationSeconds must be between 300 and 10800, got ${maxDurationSeconds}`, "WEB_PROVIDER_ERROR");
          }
          const budget =
            maxCostDollars === undefined && maxDurationSeconds === undefined
              ? undefined
              : { ...(maxCostDollars === undefined ? {} : { maxCostDollars }), ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }) };
          let run;
          if (runId !== undefined) {
            run = await client.getRun(runId, exec.signal);
          } else {
            if (rest.query === undefined) throw new WebError("exa_research needs a `query` or a `runId`", "WEB_PROVIDER_ERROR");
            run = await client.createRun({ ...rest, ...(budget === undefined ? {} : { budget }) }, exec.signal);
          }
          const deadline = Date.now() + Math.max(0, waitSeconds ?? Math.floor(researchTimeoutMs / 1000) - 15) * 1000;
          while (!TERMINAL_RUN_STATUSES.has(run?.status) && Date.now() < deadline) {
            await pause(Math.min(3000, Math.max(0, deadline - Date.now())), exec.signal);
            run = await client.getRun(run.id, exec.signal);
          }
          return run;
        },
        presentCall: (args) => ({ card: "generic", title: args.runId ?? args.query ?? "research", kind: "search", rawInput: args.query ?? args.runId }),
      }),
    );
  }
}

/** Sleep that honours the tool's cancellation signal. */
function pause(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new WebError("exa_research aborted", "WEB_ABORTED"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── plugin ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const live = () => settingsOf(config);
  const client = new ExaClient(ctx, () => connectionOf(config));

  ctx.web.registerSearchProvider(new ExaSearchProvider(client, live));
  ctx.web.registerFetchProvider(new ExaFetchProvider(client, live));
  registerTools(ctx, config, live, client);

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: "tool:exa",
      order: systemPrompt.getSectionOrder("TOOL_WEB_SEARCH"),
      text: ({ scope }) =>
        ctx.tools.get("exa_tools", scope) === undefined
          ? ""
          : "web_search and web_fetch run through Exa. For a question that needs many sources combined, use exa_research; for a cited answer rather than a list of links, exa_answer; for library and API questions, exa_code_context. When a search needs domain, date or category filters, per-result text, or similar pages, call exa_tools first to open exa_search, exa_contents or exa_similar — each costs prompt space, so open only what this question needs.",
    });
  }
}