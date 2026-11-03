/**
 * Exa transport and operations.
 *
 * Two transports, one vocabulary:
 *
 * - **REST** (`https://api.exa.ai`, `x-api-key`) — every documented endpoint and
 *   every parameter. Used whenever an Exa API key resolves.
 * - **Keyless MCP** (`https://mcp.exa.ai/mcp?tools=<name>`) — Exa's hosted MCP
 *   server, no key and no account. It exposes a strict subset (search with
 *   filters, page reading, code context). Answer / findSimilar / the Agent API
 *   are absent there and raise an actionable error instead of silently
 *   degrading, and a search that asks for something the hosted tool cannot honor
 *   fails rather than returning a quietly different result.
 *
 * Requests are always shaped as the REST body first, then translated for the
 * keyless tool, so the two paths cannot drift apart.
 *
 * @module dsh-exa/exa
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** The one credential this plugin reads. */
export const KEY_REF = "EXA_API_KEY";
export const DEFAULT_BASE_URL = "https://api.exa.ai";
export const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";

const SEARCH_TOOL = "web_search_advanced_exa";
const FETCH_TOOL = "web_fetch_exa";
const CODE_TOOL = "get_code_context_exa";
const MCP_PROTOCOL_VERSION = "2025-03-26";
/** Exa's keyless endpoint rate-limits concurrent calls; `web_search` fans out up to four. */
const KEYLESS_CONCURRENCY = 2;
/** Attempts for one keyless call, and the backoff between them. */
const KEYLESS_ATTEMPTS = 3;
const KEYLESS_BACKOFF_MS = 900;
/**
 * The hosted server reports its own quota as prose inside an otherwise
 * successful reply, with no `isError` flag, so it has to be recognized or a
 * rate-limited search would look like "no results".
 */
const KEYLESS_RATE_LIMIT = /hit Exa's free MCP rate limit|rate limit/i;
/** Search types the hosted advanced tool accepts; every other type is refused there. */
const KEYLESS_SEARCH_TYPES = new Set(["auto", "lite", "fast", "instant"]);
/** `/contents` options the hosted fetch tool has no equivalent for. */
const KEYLESS_CONTENTS_UNSUPPORTED = [
  "highlights",
  "summary",
  "extras",
  "subpages",
  "subpageTarget",
  "snapshotAsOf",
  "livecrawlTimeout",
  "maxAgeHours",
];

// ── key resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the Exa API key: a literal from the patch, else the credentials
 * plane, else the launch environment (real env var, project `.env`, or
 * `$DSH_HOME/.env`). Cheap and local — never makes a network call.
 */
export async function resolveKey(ctx, config) {
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
  const ref = credentialRef(config.apiKeyEnv || KEY_REF);
  const credentials = ctx.get("credentials");
  if (credentials) {
    const resolved = await credentials.resolve(ref);
    if (resolved?.value && resolved.value.length > 0) return resolved.value;
  }
  const env = launchEnvironmentOf(ctx).get(ref);
  if (env?.value && env.value.length > 0) return env.value;
  return undefined;
}

// ── transport ───────────────────────────────────────────────────────────────

/** Sleep that honours a cancellation signal. */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new WebError("Exa request aborted", "WEB_ABORTED"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Drop undefined and null keys so no transport ever sees a placeholder. */
export function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export function transportSignal(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}

/** Wrap a transport failure as a `WebError` that names the endpoint and keeps the cause. */
export function transportError(error, url, signal) {
  if (signal?.aborted) return new WebError(`Exa request aborted (${url})`, "WEB_ABORTED", { cause: signal.reason });
  if (error?.name === "TimeoutError") return new WebError(`Exa request timed out (${url})`, "WEB_PROVIDER_ERROR", { cause: error });
  const code = error?.cause?.code ?? error?.cause?.errno;
  const detail = code === undefined ? "" : ` [${code}]`;
  return new WebError(`Exa request failed (${url}): ${error?.message ?? error}${detail}`, "WEB_PROVIDER_ERROR", { cause: error });
}

/** Short, model-safe detail out of an Exa error body. */
function errorDetail(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : undefined) ?? parsed?.message;
    if (typeof message === "string" && message.length > 0) return `: ${message.slice(0, 400)}`;
  } catch {
    /* not JSON */
  }
  return `: ${text.slice(0, 400)}`;
}

/** One keyed REST call. Returns the parsed JSON body or throws `WebError`. */
async function restCall(config, apiKey, path, body, signal) {
  const url = `${config.baseURL.replace(/\/+$/, "")}${path}`;
  const method = body === undefined ? "GET" : "POST";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: transportSignal(signal, config.timeoutMs),
    });
  } catch (error) {
    throw transportError(error, url, signal);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new WebError(`Exa ${path} answered HTTP ${response.status}${errorDetail(text)}`, "WEB_PROVIDER_ERROR");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WebError(`Exa ${path} returned a non-JSON body`, "WEB_PROVIDER_ERROR", { cause: error });
  }
}

/** Parse one JSON-RPC reply that may arrive as SSE or as plain JSON. */
function parseRpcReply(text, contentType) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:") && !(contentType ?? "").includes("text/event-stream")) {
    return JSON.parse(trimmed);
  }
  let last;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {
      /* keep the previous reply */
    }
  }
  if (last === undefined) throw new Error("no JSON-RPC payload in the event stream");
  return last;
}

/** Keyless concurrency gate: a small FIFO so four parallel queries do not all 429. */
let keylessActive = 0;
const keylessWaiters = [];

async function acquireKeyless() {
  while (keylessActive >= KEYLESS_CONCURRENCY) await new Promise((resolve) => keylessWaiters.push(resolve));
  keylessActive += 1;
}

function releaseKeyless() {
  keylessActive -= 1;
  keylessWaiters.shift()?.();
}

/**
 * One call against Exa's hosted MCP server. Returns the tool payload: the JSON
 * document Exa packs into the text block, or `{ text }` when the tool answers
 * with prose (page reads, code context).
 */
async function mcpAttempt(config, apiKey, tool, args, signal) {
  const url = `${config.mcpURL.replace(/\/+$/, "")}?tools=${encodeURIComponent(tool)}`;
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  // Exa ignores an unusable key here (a bogus key still answers anonymously),
  // so a keyed install can pass its key through for attribution.
  if (apiKey) headers["x-api-key"] = apiKey;

  await acquireKeyless();
  let text;
  let contentType;
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
        signal: transportSignal(signal, config.timeoutMs),
      });
    } catch (error) {
      throw transportError(error, url, signal);
    }
    contentType = response.headers.get("content-type");
    text = await response.text();
    if (!response.ok) throw new WebError(`Exa MCP ${tool} answered HTTP ${response.status}${errorDetail(text)}`, "WEB_PROVIDER_ERROR");
  } finally {
    releaseKeyless();
  }

  let reply;
  try {
    reply = parseRpcReply(text, contentType);
  } catch (error) {
    throw new WebError(`Exa MCP ${tool} returned an unreadable reply`, "WEB_PROVIDER_ERROR", { cause: error });
  }
  if (reply?.error) throw new WebError(`Exa MCP ${tool} failed: ${reply.error.message ?? "unknown error"}`, "WEB_PROVIDER_ERROR");

  const result = reply?.result;
  if (!result) throw new WebError(`Exa MCP ${tool} returned no result`, "WEB_PROVIDER_ERROR");
  const joined = (result.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (result.isError === true) throw new WebError(`Exa MCP ${tool} failed: ${joined.slice(0, 400) || "tool error"}`, "WEB_PROVIDER_ERROR");

  try {
    const parsed = JSON.parse(joined);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    /* prose payload */
  }
  return { text: joined };
}

/**
 * Call a hosted MCP tool, retrying the anonymous quota. The server signals the
 * quota as prose in a successful reply, so an unrecognized limit would surface
 * as an empty result set; retrying briefly and then naming the fix keeps a
 * rate-limited search honest.
 */
async function mcpCall(config, apiKey, tool, args, signal) {
  for (let attempt = 1; ; attempt += 1) {
    const payload = await mcpAttempt(config, apiKey, tool, args, signal);
    if (typeof payload.text !== "string" || !KEYLESS_RATE_LIMIT.test(payload.text)) return payload;
    if (attempt >= KEYLESS_ATTEMPTS) {
      throw new WebError(
        "Exa's keyless endpoint is rate limited right now; retry shortly, or set EXA_API_KEY to use your own quota",
        "WEB_PROVIDER_ERROR",
      );
    }
    await sleep(KEYLESS_BACKOFF_MS * attempt, signal);
  }
}

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Split a `web_fetch_exa` page into its parts. The hosted tool answers with
 * `Title: …\nURL: …\nPublished: …\nAuthor: …\n\n<markdown>`; anything else is
 * returned verbatim.
 */
export function parseFetchedPage(text) {
  const boundary = text.search(/\r?\n\r?\n/);
  if (boundary < 0) return { text };
  const fields = {};
  for (const line of text.slice(0, boundary).split(/\r?\n/)) {
    const match = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (match === null) return { text };
    fields[match[1].toLowerCase()] = match[2].trim();
  }
  const title = fields.title;
  return compact({
    url: fields.url,
    title: title === undefined || title === "(no title)" ? undefined : title,
    publishedDate: fields.published,
    author: fields.author === "N/A" ? undefined : fields.author,
    text: text.slice(boundary).replace(/^\r?\n\r?\n/, ""),
  });
}

// ── REST body → keyless tool arguments ──────────────────────────────────────

/** Search options the hosted advanced tool has no equivalent for. */
function unsupportedByKeyless(body) {
  const dropped = [];
  const contents = body.contents ?? {};
  const text = contents.text;
  if (text !== null && typeof text === "object") {
    for (const key of ["verbosity", "includeHtmlTags", "includeSections", "excludeSections"]) {
      if (text[key] !== undefined) dropped.push(`contents.text.${key}`);
    }
  }
  const summary = contents.summary;
  if (summary !== null && typeof summary === "object" && summary.schema !== undefined) dropped.push("contents.summary.schema");
  if (contents.extras !== undefined) dropped.push("contents.extras");
  if (contents.snapshotAsOf !== undefined) dropped.push("contents.snapshotAsOf");
  if (body.outputSchema !== undefined) dropped.push("outputSchema");
  if (body.objective !== undefined) dropped.push("objective");
  if (typeof body.type === "string" && !KEYLESS_SEARCH_TYPES.has(body.type)) dropped.push(`type=${body.type}`);
  return dropped;
}

/**
 * Translate a `/search` body into `web_search_advanced_exa` arguments.
 * `dropped` names every requested option the hosted tool cannot honor.
 */
export function toKeylessSearchArgs(body) {
  const contents = body.contents ?? {};
  const text = contents.text;
  const highlights = contents.highlights;
  const summary = contents.summary;
  return {
    args: compact({
      query: body.query,
      numResults: body.numResults,
      type: KEYLESS_SEARCH_TYPES.has(body.type) ? body.type : undefined,
      category: body.category,
      includeDomains: body.includeDomains,
      excludeDomains: body.excludeDomains,
      startPublishedDate: body.startPublishedDate,
      endPublishedDate: body.endPublishedDate,
      userLocation: typeof body.userLocation === "string" ? body.userLocation : undefined,
      moderation: body.moderation,
      additionalQueries: body.additionalQueries,
      textMaxCharacters: typeof text === "object" && text !== null ? text.maxCharacters : undefined,
      enableHighlights: highlights === undefined ? undefined : highlights !== false,
      highlightsMaxCharacters: typeof highlights === "object" && highlights !== null ? highlights.maxCharacters : undefined,
      highlightsQuery: typeof highlights === "object" && highlights !== null ? highlights.query : undefined,
      enableSummary: summary === undefined ? undefined : summary !== false,
      summaryQuery: typeof summary === "object" && summary !== null ? summary.query : undefined,
      maxAgeHours: contents.maxAgeHours,
      livecrawlTimeout: contents.livecrawlTimeout,
      subpages: contents.subpages,
      subpageTarget: contents.subpageTarget,
      contextMaxCharacters: typeof contents.context === "object" && contents.context !== null ? contents.context.maxCharacters : undefined,
    }),
    dropped: unsupportedByKeyless(body),
  };
}

// ── client ──────────────────────────────────────────────────────────────────

/**
 * The operations layer shared by the two providers and the extra tools.
 * Every method returns Exa's own response shape, so callers map once.
 */
export class ExaClient {
  #ctx;
  #live;

  /**
   * @param ctx - the plugin context, used to resolve the credential.
   * @param live - reads the connection settings; called on every request so a
   *   settings edit applies to the next request without remounting the plugin.
   */
  constructor(ctx, live) {
    this.#ctx = ctx;
    this.#live = typeof live === "function" ? live : () => live;
  }

  /** The connection settings in force for this request. */
  get config() {
    return this.#live();
  }

  /** `"rest"` when a key resolves, else `"keyless"`. */
  async mode() {
    return (await resolveKey(this.#ctx, this.config)) ? "rest" : "keyless";
  }

  /** One search. `body` is the `/search` request body. */
  async search(body, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (apiKey) return restCall(this.config, apiKey, "/search", body, signal);
    const { args, dropped } = toKeylessSearchArgs(body);
    if (dropped.length > 0) {
      throw new WebError(
        `Exa keyless mode cannot honor ${dropped.join(", ")}; set an Exa API key (EXA_API_KEY) to use it`,
        "WEB_PROVIDER_ERROR",
      );
    }
    return mcpCall(this.config, undefined, SEARCH_TOOL, args, signal);
  }

  /** One `/contents` request. Keyless mode serves `urls` only, one page read per URL. */
  async contents(body, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (apiKey) return restCall(this.config, apiKey, "/contents", body, signal);
    if (!Array.isArray(body.urls) || body.urls.length === 0) {
      throw new WebError("Without an Exa API key, exa_contents needs `urls` (document ids are keyed-only)", "WEB_PROVIDER_ERROR");
    }
    const ignored = KEYLESS_CONTENTS_UNSUPPORTED.filter((key) => body[key] !== undefined);
    if (ignored.length > 0) {
      throw new WebError(
        `Exa keyless mode cannot honor ${ignored.join(", ")}; set an Exa API key (EXA_API_KEY) to use it`,
        "WEB_PROVIDER_ERROR",
      );
    }
    const text = body.text;
    const maxCharacters = text !== null && typeof text === "object" ? text.maxCharacters : undefined;
    const results = [];
    const statuses = [];
    for (const url of body.urls) {
      try {
        // The hosted tool answers with the first readable page only, so each
        // URL gets its own call.
        const payload = await mcpCall(this.config, undefined, FETCH_TOOL, compact({ urls: [url], maxCharacters }), signal);
        const page = typeof payload.text === "string" ? parseFetchedPage(payload.text) : {};
        results.push({ title: page.title ?? url, url: page.url ?? url, ...page, text: page.text ?? "" });
        statuses.push({ id: url, status: "success" });
      } catch (error) {
        if (error?.code === "WEB_ABORTED") throw error;
        statuses.push({ id: url, status: "error", error: { tag: error?.message ?? "FETCH_FAILED" } });
      }
    }
    return { results, statuses };
  }

  /** `/answer` — keyed only. */
  async answer(body, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (!apiKey) throw new WebError("exa_answer needs an Exa API key (set EXA_API_KEY); the keyless MCP server has no answer tool", "WEB_PROVIDER_ERROR");
    return restCall(this.config, apiKey, "/answer", body, signal);
  }

  /** `/findSimilar` — keyed only. */
  async findSimilar(body, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (!apiKey) throw new WebError("exa_similar needs an Exa API key (set EXA_API_KEY); the keyless MCP server has no findSimilar tool", "WEB_PROVIDER_ERROR");
    return restCall(this.config, apiKey, "/findSimilar", body, signal);
  }

  /** Code context. Only the hosted MCP server offers it, so it works with or without a key. */
  async codeContext(query, numResults, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    return mcpCall(this.config, apiKey, CODE_TOOL, compact({ query, numResults }), signal);
  }

  /** Create an Agent run — keyed only. */
  async createRun(body, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (!apiKey) throw new WebError("exa_research needs an Exa API key (set EXA_API_KEY); the Agent API is keyed-only", "WEB_PROVIDER_ERROR");
    return restCall(this.config, apiKey, "/agent/runs", body, signal);
  }

  /** Read one Agent run — keyed only. */
  async getRun(id, signal) {
    const apiKey = await resolveKey(this.#ctx, this.config);
    if (!apiKey) throw new WebError("exa_research needs an Exa API key (set EXA_API_KEY); the Agent API is keyed-only", "WEB_PROVIDER_ERROR");
    return restCall(this.config, apiKey, `/agent/runs/${encodeURIComponent(id)}`, undefined, signal);
  }
}
