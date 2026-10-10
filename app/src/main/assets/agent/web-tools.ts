/**
 * web_search and web_fetch: the two web tools, both free, with no API key anywhere. Built in, not
 * an extension.
 *
 * Why this exists: the agent could not search the web at all. Every search backend worth using
 * wants a credential, and this app has nowhere to put one -- auth.json holds model providers, and
 * handing the user a "go sign up and paste a key" flow for a search box is a bad trade. So this
 * talks to the two search MCP servers that serve anonymous traffic, and keeps a scraper as a backstop.
 *
 * The chain, in order:
 *   1. Parallel   https://search.parallel.ai/mcp    their docs: "The Search MCP is free to use -- no
 *                                                   API key required, great for exploration and light use".
 *                                                   Best output of the three: results arrive as
 *                                                   LLM-shaped, pre-compressed excerpts.
 *   2. Exa        https://mcp.exa.ai/mcp           "Free rate-limited usage without sign-in or API key".
 *                                                   Different index than Parallel's, so it is a real
 *                                                   second opinion rather than a retry of the same one.
 *   3. DuckDuckGo html.duckduckgo.com/html/        no key, no account, no MCP. Scraper of last resort.
 *
 * Fallback is sequential, never a fan-out: the anonymous tiers are a shared courtesy, and firing all
 * three at once to save a second is how you get rate-limited off them. First provider that returns
 * usable results wins; the rest are not called.
 *
 * Provider quirks that shaped the code, all verified against the live endpoints rather than docs
 * alone: Parallel's MCP tool takes {objective, search_queries, session_id} and no result-count knob
 * (anonymous requests are pinned to "fast" mode with server-managed search settings, and Parallel
 * documents that search overrides are ignored without a key) -- so there is deliberately no `recency`
 * parameter here to map anywhere. Exa's web_search_exa requires BOTH query and objective.
 *
 * The MCP client below is hand-rolled because the wire format is small: JSON-RPC 2.0 over
 * streamable HTTP, one POST per message, replies as either a JSON body or a one-event SSE frame, and
 * the session id arrives as a response header on initialize. That is the whole protocol surface used
 * here, so pulling in an SDK for it would be more code than this.
 *
 * web_fetch reads a single URL. Jina Reader (r.jina.ai) renders the page and hands back markdown,
 * which is the whole reason it is worth using: a JS-heavy docs page arrives as readable prose
 * instead of a wall of <script>. Its own reader needs an API key for anything but light use, and
 * Cloudflare's Browser Rendering /markdown endpoint -- the other thing that converts a page to
 * markdown -- is POST /accounts/{account_id}/browser-rendering/markdown and answers 401 without an
 * account, so neither is an option for a sandbox with nowhere to keep a credential. Behind Jina
 * sits a plain fetch with an HTML-to-text pass: worse output, but it depends on nobody.
 *
 * It lives here rather than in extensions/ because being able to read the web is core to being able
 * to answer questions at all, not a capability to hot-swap away. It is still a pi-durable extension
 * in the mechanical sense -- defineExtension({tools}), installed into the registry by server.ts
 * alongside CodingTools and the pidroid tools -- which keeps server.ts itself from growing by several
 * hundred lines.
 *
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const PARALLEL_MCP = "https://search.parallel.ai/mcp";
const EXA_MCP = "https://mcp.exa.ai/mcp";

/**
 * Per-provider ceiling. Both MCP providers answer typical queries in 1-3s, so 20s is generous;
 * it is a backstop against a hung connection, not an expected wait.
 *
 * It also bounds the worst case: the chain is sequential, so three stalled providers cost 60s of
 * dead air before the tool reports failure. Observed in practice -- Exa's anonymous tier
 * occasionally holds the connection open instead of answering, which is what this exists to survive.
 */
const TIMEOUT_MS = 20_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

/**
 * One stable id for the whole process, reused across calls.
 *
 * Parallel documents session_id as "used for free-tier rate limiting and log correlation, and is
 * ignored for rate limiting on paid-tier keys", and warns that changing it mid-conversation
 * "can split free-tier rate-limit accounting". A per-process constant gives one bucket per app run,
 * which is the closest thing to "per conversation" available from inside a tool.
 */
const SESSION_ID = crypto.randomUUID();

/**
 * Minimal MCP client: enough of the streamable-HTTP transport for one tool call.
 *
 * A fresh session is opened lazily and reused for the client's lifetime. If the handshake fails the
 * cached promise is dropped rather than kept, so a later call can retry instead of replaying the
 * first failure forever.
 */
class McpClient {
  private sessionId: string | null = null;
  private handshake: Promise<void> | null = null;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly clientName: string,
  ) {}

  private async post(body: unknown, signal: AbortSignal): Promise<{ data: any; headers: Headers }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable HTTP replies as SSE unless the client asks for JSON too.
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    return { data: parseRpc(text), headers: res.headers };
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const { data, headers } = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: this.clientName, version: "1" },
        },
      },
      signal,
    );
    if (data?.error) throw new Error(`initialize failed: ${data.error.message ?? JSON.stringify(data.error)}`);
    this.sessionId = headers.get("mcp-session-id");
    // The notification is protocol bookkeeping, not a question: no reply is expected, so a rejection
    // here says nothing about whether tools/call will work.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {});
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; meta: any }> {
    if (!this.handshake) {
      this.handshake = this.connect(signal).catch((err) => {
        this.handshake = null; // let the next call try again
        throw err;
      });
    }
    await this.handshake;

    const { data } = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } },
      signal,
    );
    if (data?.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
    const result = data?.result;
    const blocks = result?.content;
    if (!Array.isArray(blocks) || !blocks.length) throw new Error("no content in tool result");
    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    if (!text.trim()) throw new Error("tool returned no text");
    return { text, meta: result._meta };
  }
}

/**
 * A free-tier refusal arrives as HTTP 200 with an apology in the text and a flag in _meta
 * (Exa sends {"ai.exa/rateLimited": true}), so a status check alone reports it as a successful
 * empty search. Catching the flag turns it into a real error, which is what makes the chain fall
 * through to the next provider instead of claiming there is nothing on the web to find.
 */
function assertNotRateLimited(meta: any, provider: string): void {
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (/rate.?limit/i.test(key) && value) throw new Error(`${provider}: free-tier rate limit reached`);
  }
}

/**
 * Pull the JSON-RPC payload out of a response body.
 *
 * Servers answer either with a bare JSON body or with SSE framing ("event: message" then "data: {...}").
 * The data lines are joined before parsing, which is what makes multi-line payloads survive.
 */
function parseRpc(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const chunks = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!chunks.length) throw new Error("unrecognized response framing");
  return JSON.parse(chunks.join("\n"));
}

const parallel = new McpClient(PARALLEL_MCP, "pidroid-web-search");
const exa = new McpClient(EXA_MCP, "pidroid-web-search");

/** Provider 1: Parallel Search MCP, anonymous free tier. */
async function searchParallel(query: string, limit: number): Promise<SearchResult[]> {
  const { text, meta } = await parallel.callTool(
    "web_search",
    { objective: query, search_queries: [query], session_id: SESSION_ID },
    AbortSignal.timeout(TIMEOUT_MS),
  );
  assertNotRateLimited(meta, "parallel");
  const payload = JSON.parse(text);
  const results: SearchResult[] = (payload.results ?? []).map((r: any) => ({
    title: String(r.title ?? r.url ?? ""),
    url: String(r.url ?? ""),
    // Excerpts arrive as an array of pre-compressed page fragments; join the useful ones.
    snippet: collapse(Array.isArray(r.excerpts) ? r.excerpts.join("\n") : (r.excerpts ?? r.snippet ?? "")),
    date: r.publish_date ? String(r.publish_date) : undefined,
  }));
  if (!results.length) throw new Error("no results");
  return results.slice(0, limit);
}

/**
 * Provider 2: Exa MCP, anonymous free tier.
 *
 * Its search tool returns preformatted text rather than JSON ("Title: ...\nURL: ...\nHighlights: ..."
 * blocks separated by ---), so this parses that shape. It is the documented output of
 * exa-mcp-server's web_search_exa, and the fields it depends on are all top-level labels.
 */
async function searchExa(query: string, limit: number): Promise<SearchResult[]> {
  const { text, meta } = await exa.callTool(
    "web_search_exa",
    { query, objective: query, numResults: limit },
    AbortSignal.timeout(TIMEOUT_MS),
  );
  assertNotRateLimited(meta, "exa");
  const results: SearchResult[] = [];
  for (const block of text.split(/\n-{3,}\n/)) {
    const url = block.match(/^URL:\s*(\S+)/m)?.[1];
    if (!url) continue;
    results.push({
      title: block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? url,
      url,
      date: published(block),
      snippet: collapse(block.match(/^Highlights:\s*\n([\s\S]*)$/m)?.[1] ?? ""),
    });
  }
  if (!results.length) {
    // A refusal that carries no flag still has to be recognisable, so quote what came back rather
    // than reporting an empty result set.
    throw new Error(`no results in response: ${collapse(text).slice(0, 160)}`);
  }
  return results.slice(0, limit);
}

/** Exa writes "N/A" in the Published line when it has no date; that is not a date. */
function published(block: string): string | undefined {
  const value = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
  return value && value !== "N/A" ? value : undefined;
}

/**
 * Provider 3: DuckDuckGo's no-JS HTML frontend, scraped.
 *
 * Always available and account-free, so it is the floor the chain cannot fall through. DuckDuckGo
 * answers throttled/datacenter traffic with a bot challenge at HTTP 200, which is why an empty parse
 * is an error and not an empty result set -- otherwise a challenge page reads as "nothing found".
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent":
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Each result is one title anchor plus one snippet anchor, in that document order, so the two
  // lists pair up index for index. Matching on the class attribute alone keeps this working whether
  // or not DuckDuckGo puts href before it.
  const snippetList: string[] = [];
  for (const m of html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
    snippetList.push(stripTags(m[1]));
  }

  const results: SearchResult[] = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = unwrapDuckDuckGoUrl(m[1]);
    if (!url) continue;
    results.push({ title: stripTags(m[2]), url, snippet: collapse(snippetList[results.length] ?? "") });
  }
  if (!results.length) throw new Error("no results (bot challenge or empty page)");
  return results.slice(0, limit);
}

/** DuckDuckGo sometimes wraps results in a redirect; the real target is in the uddg parameter. */
function unwrapDuckDuckGoUrl(href: string): string | null {
  const decoded = decodeURIComponent(href).replace(/^\/\//, "https://");
  if (!/duckduckgo\.com\/l\//.test(decoded)) return decoded;
  const target = new URL(decoded).searchParams.get("uddg");
  return target ? decodeURIComponent(target) : null;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Snippets are for grounding, not for filling the context window. */
function collapse(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}...` : flat;
}

/** Each provider gets one attempt; a provider that throws hands over to the next one. */
const PROVIDERS: { name: string; search: (q: string, limit: number) => Promise<SearchResult[]> }[] = [
  { name: "parallel", search: searchParallel },
  { name: "exa", search: searchExa },
  { name: "duckduckgo", search: searchDuckDuckGo },
];

const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the live web and return ranked results with titles, URLs and short excerpts. Use it for " +
    "anything that may have changed since training: library versions, API syntax, error messages, " +
    "release notes, current prices, or 'what is X'. Queries work best as 3-6 keyword words; " +
    "site:github.com/oven-sh is respected. Free and needs no API key -- it queries Parallel, then " +
    "Exa, then DuckDuckGo, in that order, and returns as soon as one answers. Returns excerpts only, " +
    "so open a URL with fetch or curl when the full text of a page is needed.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query: keywords, optionally with site: or quoted phrases" }),
    numResults: Type.Optional(
      Type.Number({ description: "How many results to return (default 8, max 20)" }),
    ),
    provider: Type.Optional(
      Type.Union(
        [Type.Literal("parallel"), Type.Literal("exa"), Type.Literal("duckduckgo")],
        {
          description:
            "Force one backend instead of the default chain. The chain already falls back on its own; " +
            "use this to go straight to a different index when one is missing what you need.",
        },
      ),
    ),
  }),
  execute: async (args, api) => {
    const query = String(args.query ?? "").trim();
    if (!query) {
      api.output("Error: query is required.");
      return {};
    }
    const forced = args.provider ? String(args.provider) : null;
    if (forced && !PROVIDERS.some((p) => p.name === forced)) {
      api.output(`Error: unknown provider "${forced}". Use one of: ${PROVIDERS.map((p) => p.name).join(", ")}.`);
      return {};
    }
    const limit = Math.min(20, Math.max(1, Math.round(Number(args.numResults) || 8)));

    const failures: string[] = [];
    for (const provider of PROVIDERS) {
      if (forced && provider.name !== forced) continue;
      let results: SearchResult[];
      try {
        results = await provider.search(query, limit);
      } catch (err) {
        failures.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const lines = [`Results for "${query}" (via ${provider.name}):`];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}${r.date ? ` (${r.date.slice(0, 10)})` : ""}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
      });
      if (failures.length) {
        lines.push(`(Earlier providers were tried first and failed: ${failures.join("; ")})`);
      }
      api.output(lines.join("\n"));
      return {};
    }

    api.output(`Error: every search provider failed.\n${failures.join("\n")}`);
    return {};
  },
});

/* ---------- web_fetch ---------- */

const JINA_READER = "https://r.jina.ai/";
/** Jina renders the page in a headless browser, so it needs longer than a plain HTTP GET. */
const JINA_TIMEOUT_MS = 45_000;
const DIRECT_TIMEOUT_MS = 20_000;

/** Enough to read most articles and docs pages; more than this is a page nobody asked to read. */
const DEFAULT_MAX_CHARS = 12_000;
const HARD_MAX_CHARS = 60_000;

/**
 * Reject targets that are not really on the web.
 *
 * The agent server itself listens on loopback, and auth.json lives in this sandbox, so a fetch of
 * http://127.0.0.1:<port>/ would hand the model the app's own endpoints. That is a self-inflicted
 * wound rather than an attack -- the model would have to be talked into it -- but "fetch this URL"
 * is the easiest tool in the box to aim at something it should not, so the addresses are refused
 * outright rather than left to judgement. Everything the tools legitimately need is public.
 */
function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https can be fetched, got ${url.protocol.replace(":", "")}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(
      `refusing to fetch ${url.hostname}: loopback, private and link-local addresses are not part of the web ` +
        `(and this app's own server is listening on one of them)`,
    );
  }
  return url;
}

/** True for loopback, RFC1918, link-local, and the mDNS/.localhost names that resolve into them. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  // IPv6: ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local.
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) {
    return true;
  }
  const quad = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!quad) return false;
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * How much of the page to hand back.
 *
 * The default runs the DOM through readability, which throws away everything it does not recognise
 * as the main article: nav, footers, ads, and -- the part that actually bites -- content in a
 * collapsed tab, a lazy-loaded block, or anything inside an iframe. That is the right default for
 * "read this article" and the wrong one for "read this API reference", where the table you need may
 * be the thing readability discarded. These map to Jina's own x-respond-with values, so "full" and
 * "text" are the unfiltered page rather than a different guess at what mattered.
 */
const FETCH_FORMATS = {
  markdown: undefined, // Jina's default: readability-filtered markdown
  full: "markdown+frontmatter", // whole page as markdown, no readability filtering
  text: "text", // document.body.innerText -- whole page, unformatted
  html: "html", // documentElement.outerHTML -- raw, for when even the text pass loses something
} as const;

type FetchFormat = keyof typeof FETCH_FORMATS;

/**
 * Provider 1: Jina Reader. Prepending r.jina.ai to a URL returns the page as markdown, rendered.
 *
 * X-No-Cache because the default is a cached snapshot (3600s), and a snapshot is exactly wrong for
 * an agent asking what a page says *now* -- the cached copy even carries a warning saying so.
 */
async function fetchViaJina(url: URL, format: FetchFormat, signal: AbortSignal): Promise<string> {
  const respondWith = FETCH_FORMATS[format];
  const res = await fetch(`${JINA_READER}${url.href}`, {
    headers: {
      "x-no-cache": "true",
      accept: "text/plain",
      ...(respondWith ? { "x-respond-with": respondWith } : {}),
    },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!text.trim()) throw new Error("empty document");
  // Jina answers 200 even for a page that 404'd, with the complaint in the body ("Warning: Target
  // URL returned error 404"). That text is genuinely useful, so it is passed through rather than
  // turned into an error -- but a body that is nothing but the warning means there is no page here.
  if (/^Warning: Target URL returned error/m.test(text) && text.length < 400) {
    throw new Error(text.trim().slice(0, 160));
  }
  return text;
}

/** Provider 2: plain fetch, HTML reduced to text. No third party, no rendering, worse output. */
async function fetchDirect(url: URL, _format: FetchFormat, signal: AbortSignal): Promise<string> {
  const res = await fetch(url.href, {
    redirect: "follow",
    headers: {
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A public URL can still redirect into the private ranges refused above.
  if (isPrivateHost(new URL(res.url || url.href).hostname)) {
    throw new Error(`redirected to ${res.url}, which is not a public address`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!contentType.includes("html")) return body;
  const text = htmlToText(body);
  if (text.length < 80) throw new Error("page yielded almost no text (JS-rendered?)");
  return `Source: ${res.url}\n\n${text}`;
}

/**
 * HTML to readable text: drop the parts that are not prose, keep the paragraph structure.
 *
 * Crude on purpose. It only has to be good enough to read a page that Jina could not render, and a
 * dependency-free guess beats nothing at all.
 */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|section|article|tr|li|h[1-6]|pre|blockquote)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FETCHERS: { name: string; fetch: (u: URL, f: FetchFormat, signal: AbortSignal) => Promise<string> }[] = [
  { name: "jina", fetch: fetchViaJina },
  { name: "direct", fetch: fetchDirect },
];

const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a URL and return the page as markdown text. Use it after web_search (or curl) when an " +
    "excerpt is not enough and the whole page is needed: release notes, a docs page, an issue thread, " +
    "a spec. Free and needs no API key -- it reads the page through Jina's reader, which renders " +
    "JavaScript, and falls back to a plain fetch if that fails. Long pages are clipped; pass " +
    "maxChars to raise the limit. Refuses loopback and private addresses.",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute http(s) URL to read" }),
    maxChars: Type.Optional(
      Type.Number({ description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})` }),
    ),
    format: Type.Optional(
      Type.Union(
        [Type.Literal("markdown"), Type.Literal("full"), Type.Literal("text"), Type.Literal("html")],
        {
          description:
            "How much of the page to return. 'markdown' (default) keeps only the main article. " +
            "'full' is the whole page as markdown, 'text' the whole page as plain text, 'html' the raw " +
            "document. Use anything but 'markdown' when the default may have dropped what you need -- " +
            "docs tables, collapsed sections, iframes -- since filtering is what loses it.",
        },
      ),
    ),
  }),
  execute: async (args, api) => {
    let url: URL;
    try {
      url = assertFetchableUrl(String(args.url ?? ""));
    } catch (err) {
      api.output(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
    const limit = Math.min(HARD_MAX_CHARS, Math.max(500, Math.round(Number(args.maxChars) || DEFAULT_MAX_CHARS)));
    const format = (args.format && args.format in FETCH_FORMATS ? String(args.format) : "markdown") as FetchFormat;

    const failures: string[] = [];
    for (const fetcher of FETCHERS) {
      let text: string;
      try {
        // Jina gets the long budget because it renders; the direct fallback needs far less.
        const timeout = fetcher.name === "jina" ? JINA_TIMEOUT_MS : DIRECT_TIMEOUT_MS;
        text = await fetcher.fetch(url, format, AbortSignal.timeout(timeout));
      } catch (err) {
        failures.push(`${fetcher.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const clipped = text.length > limit;
      const body = clipped ? `${text.slice(0, limit)}\n\n[clipped at ${limit} chars of ${text.length}; raise maxChars for more]` : text;
      api.output(
        [
          `Fetched ${url.href} via ${fetcher.name} as ${format} (${text.length} chars${clipped ? `, showing ${limit}` : ""})`,
          ...(failures.length ? [`Earlier: ${failures.join("; ")}`] : []),
          "",
          body,
        ].join("\n"),
      );
      return {};
    }

    api.output(`Error: could not fetch ${url.href}.\n${failures.join("\n")}`);
    return {};
  },
});

export default defineExtension({
  name: "web-tools",
  tools: [webSearch, webFetch],
});