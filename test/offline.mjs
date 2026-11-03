/**
 * Offline checks: config/schema compilation, provider registration, and the
 * keyless translation. No network.
 */
import assert from "node:assert/strict";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { Config, apply, htmlToText, isLocalUrl } from "../lib/index.js";
import { compact, parseFetchedPage, toKeylessSearchArgs } from "../lib/exa.js";

const failures = [];
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

console.log("config schema");
const config = Config({});
const get = (name) => config[name].get();
await check("defaults compile", () => {
  assert.equal(get("apiKeyEnv"), "EXA_API_KEY");
  assert.equal(get("baseURL"), "https://api.exa.ai");
  assert.equal(get("searchType"), "auto");
  assert.equal(get("searchHighlights"), true);
  assert.equal(get("searchText"), false);
  assert.equal(get("toolResearch"), true);
  assert.equal(get("timeoutMs"), 30000);
  assert.equal(get("searchCategory"), undefined);
  assert.deepEqual(get("searchIncludeDomains"), []);
});
await check("every field the Settings page edits is marked live, and only those", () => {
  const json = Config.toJSON();
  const root = json.refs[json.uid];
  const volatile = Object.keys(root.dict).filter((key) => json.refs[root.dict[key]]?.meta?.volatile === true);
  const fixed = Object.keys(root.dict).filter((key) => json.refs[root.dict[key]]?.meta?.volatile !== true);
  assert.equal(volatile.length, 21);
  // A tool timeout is fixed when the tool is registered, so it must not claim to be live.
  assert.deepEqual(fixed, ["researchTimeoutMs"]);
});

console.log("\nregistration");
const registered = [];
const sections = [];
let volatileListener;
const fakeSystemPrompt = {
  section: (section) => sections.push(section),
  getSectionOrder: (name) => (name === "TOOL_WEB_SEARCH" ? 2000 : undefined),
};
const fakeCtx = {
  web: {
    registerSearchProvider: (provider) => registered.push(["search", provider]),
    registerFetchProvider: (provider) => registered.push(["fetch", provider]),
  },
  tools: {
    register: (tool) => {
      const entry = ["tool", tool];
      registered.push(entry);
      return () => {
        const at = registered.indexOf(entry);
        if (at >= 0) registered.splice(at, 1);
      };
    },
    get: () => undefined,
  },
  get: (name) => (name === "systemPrompt" ? fakeSystemPrompt : undefined),
  effect: (fn) => fn(),
  on: (event, listener) => {
    if (event === "loader/volatile-update") volatileListener = listener;
    return () => {};
  },
};
apply(fakeCtx, config);

const providers = registered.filter(([kind]) => kind === "search" || kind === "fetch");
await check("both providers register as exa", () => {
  assert.deepEqual(
    providers.map(([kind, provider]) => [kind, provider.id]),
    [
      ["search", "exa"],
      ["fetch", "exa"],
    ],
  );
});
await check("providers report available without a network call", () => {
  for (const [, provider] of providers) assert.equal(provider.available(), true);
});

const tools = registered.filter(([kind]) => kind === "tool").map(([, tool]) => tool);
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const startupNames = () => registered.filter(([kind]) => kind === "tool").map(([, tool]) => tool.name);
await check("the cheap multi-source tools are on from the first turn", () => {
  assert.deepEqual([...byName.keys()].sort(), ["exa_answer", "exa_code_context", "exa_research", "exa_tools"]);
});
await check("the expensive schemas stay closed until asked for", async () => {
  const value = await byName.get("exa_tools").execute({}, {});
  const closed = value.available.filter((entry) => entry.open === false).map((entry) => entry.key);
  assert.deepEqual(closed, ["search", "contents", "similar"]);
});

console.log("\nprogressive exposure");
await check("the unlock tool reports what is open", async () => {
  const value = await byName.get("exa_tools").execute({}, {});
  assert.deepEqual(value.active, ["answer", "code", "research"]);
  assert.deepEqual(
    value.available.map((entry) => entry.key),
    ["search", "contents", "answer", "similar", "code", "research"],
  );
});
await check("opening a tool registers it, closing it removes it", async () => {
  const unlock = byName.get("exa_tools");
  await unlock.execute({ enable: ["similar"] }, {});
  assert.deepEqual(startupNames().sort(), ["exa_answer", "exa_code_context", "exa_research", "exa_similar", "exa_tools"]);
  await unlock.execute({ disable: ["similar"] }, {});
  assert.deepEqual(startupNames().sort(), ["exa_answer", "exa_code_context", "exa_research", "exa_tools"]);
});
await check("a tool pinned on by settings can still be closed for the session", async () => {
  const unlock = byName.get("exa_tools");
  await unlock.execute({ disable: ["answer"] }, {});
  const value = await unlock.execute({}, {});
  // The session knows what this task needs better than the default does.
  assert.equal(value.available.find((entry) => entry.key === "answer").open, false);
  await unlock.execute({ enable: ["answer"] }, {});
});
await check("unknown keys are ignored rather than throwing", async () => {
  const value = await byName.get("exa_tools").execute({ enable: ["nope", "search"] }, {});
  assert.deepEqual(value.active, ["search", "answer", "code", "research"]);
  await byName.get("exa_tools").execute({ disable: ["search"] }, {});
});

// Open every advanced tool once so the rest of the checks can inspect them.
await byName.get("exa_tools").execute({ enable: ["search", "contents", "answer", "similar", "code", "research"] }, {});
const advanced = registered
  .filter(([kind]) => kind === "tool")
  .map(([, tool]) => tool)
  .filter((tool) => tool.name !== "exa_tools");
const advancedByName = new Map(advanced.map((tool) => [tool.name, tool]));

// `defineTool` compiled both schemas through the authoring DSL at registration,
// so a rejected schema would already have thrown. Assert the compiled result is
// supported and that requiredness survived.
console.log("\ntool schemas");
for (const tool of advanced) {
  check(`${tool.name} parameters are a supported object schema`, () => {
    assertSupportedJsonSchema(tool.parameters);
    assert.equal(tool.parameters.type, "object");
  });
  check(`${tool.name} output schema is supported`, () => {
    assertSupportedJsonSchema(tool.output.schema);
  });
}
await check("required parameters survive compilation", () => {
  assert.deepEqual(advancedByName.get("exa_search").parameters.required, ["query"]);
  assert.equal(advancedByName.get("exa_contents").parameters.required, undefined);
  assert.deepEqual(advancedByName.get("exa_answer").parameters.required, ["query"]);
  assert.deepEqual(advancedByName.get("exa_similar").parameters.required, ["url"]);
  assert.deepEqual(advancedByName.get("exa_code_context").parameters.required, ["query"]);
  assert.equal(advancedByName.get("exa_research").parameters.required, undefined);
});
await check("nested oneOf content options compile", () => {
  const text = advancedByName.get("exa_search").parameters.properties.contents.properties.text;
  assert.equal(text.oneOf.length, 2);
  assert.equal(text.oneOf[0].type, "boolean");
  assert.equal(text.oneOf[1].type, "object");
  assert.deepEqual(text.oneOf[1].properties.verbosity.enum, ["compact", "standard", "full"]);
});
await check("json-typed parameters compile to an open schema", () => {
  const schema = advancedByName.get("exa_answer").parameters.properties.outputSchema;
  assert.deepEqual(schema, { description: schema.description });
});
await check("one prompt section is contributed, gated on exa_tools", () => {
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "tool:exa");
  assert.equal(sections[0].order, 2000);
  assert.equal(sections[0].text({ scope: {} }), "");
});

console.log("\nkeyless translation");
await check("plain search maps straight across", () => {
  const { args, dropped } = toKeylessSearchArgs({ query: "rust async runtime", numResults: 5, type: "auto", contents: { highlights: true } });
  assert.deepEqual(dropped, []);
  assert.equal(args.query, "rust async runtime");
  assert.equal(args.numResults, 5);
  assert.equal(args.enableHighlights, true);
});
await check("unsupported options are reported, not silently dropped", () => {
  const { dropped } = toKeylessSearchArgs({
    query: "x",
    type: "deep",
    objective: "find the paper",
    contents: { text: { maxCharacters: 100, verbosity: "full" }, extras: { links: 3 }, highlights: { query: "q" } },
  });
  assert.deepEqual(dropped.sort(), ["contents.extras", "contents.text.verbosity", "objective", "type=deep"].sort());
});
await check("supported text and highlight options survive", () => {
  const { args, dropped } = toKeylessSearchArgs({
    query: "x",
    type: "fast",
    contents: { text: { maxCharacters: 500 }, highlights: { maxCharacters: 200, query: "steer" }, maxAgeHours: 0 },
  });
  assert.deepEqual(dropped, []);
  assert.equal(args.type, "fast");
  assert.equal(args.textMaxCharacters, 500);
  assert.equal(args.highlightsMaxCharacters, 200);
  assert.equal(args.highlightsQuery, "steer");
  assert.equal(args.maxAgeHours, 0);
});

console.log("\npage parsing");
await check("hosted page header is split off", () => {
  const page = parseFetchedPage("Title: Hello\nURL: https://example.com/a\nPublished: 2024-01-02\nAuthor: N/A\n\nThe body text.");
  assert.equal(page.title, "Hello");
  assert.equal(page.url, "https://example.com/a");
  assert.equal(page.publishedDate, "2024-01-02");
  assert.equal(page.author, undefined);
  assert.equal(page.text, "The body text.");
});
await check("plain prose is returned verbatim", () => {
  assert.deepEqual(parseFetchedPage("no header here"), { text: "no header here" });
});
await check("compact drops undefined and null only", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: false }), { a: 1, d: false });
});

console.log("\nlocal pages");
await check("loopback and private hosts bypass Exa", () => {
  for (const url of [
    "http://127.0.0.1:24414/",
    "http://localhost:3000/app",
    "http://[::1]:8080/",
    "http://192.168.1.1/admin",
    "http://10.0.0.5/",
    "http://172.20.1.4/",
    "http://169.254.169.254/latest/meta-data",
    "http://printer.local/",
  ]) {
    assert.equal(isLocalUrl(url), true, `${url} must be read directly`);
  }
});

await check("public hosts still go through Exa", () => {
  for (const url of ["https://example.com/", "https://exa.ai/docs", "http://8.8.8.8/", "https://172.32.0.1/", "not a url"]) {
    assert.equal(isLocalUrl(url), false, `${url} must not be treated as local`);
  }
});

await check("html is reduced to readable text", () => {
  const text = htmlToText("<html><head><title>t</title><style>a{}</style></head><body><h1>Hi</h1><p>One &amp; two</p><script>x()</script></body></html>");
  assert.equal(text.includes("a{}"), false);
  assert.equal(text.includes("x()"), false);
  assert.equal(text.includes("Hi"), true);
  assert.equal(text.includes("One & two"), true);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall offline checks passed");
