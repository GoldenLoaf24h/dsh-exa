/**
 * Live checks against Exa. No API key is needed: these exercise the keyless
 * hosted MCP path, which is what a fresh install uses.
 */
import assert from "node:assert/strict";
import { ExaClient } from "../lib/exa.js";

const config = {
  apiKeyEnv: "EXA_API_KEY",
  baseURL: "https://api.exa.ai",
  mcpURL: "https://mcp.exa.ai/mcp",
  timeoutMs: 60000,
};

// A context with no credentials plane and an empty launch environment, so key
// resolution finds nothing and every call takes the keyless path.
const ctx = {
  get: () => undefined,
  launchEnvironment: { get: () => undefined },
};
// `launchEnvironmentOf(ctx)` reads a branded symbol off the context; give it one
// that reports nothing so the test stays offline for credential lookup.
const client = new ExaClient(ctx, config);

const failures = [];
async function check(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`  ok   ${label} (${Date.now() - started}ms)`);
    return value;
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
    console.log(`  FAIL ${label} (${Date.now() - started}ms): ${error?.message ?? error}`);
    return undefined;
  }
}

console.log("keyless mode");
await check("no key resolves, so the client reports keyless", async () => {
  assert.equal(await client.mode(), "keyless");
});

console.log("\nsearch");
const search = await check("search returns real results", async () => {
  const payload = await client.search({ query: "Exa AI search API", numResults: 3, type: "auto", contents: { highlights: true } }, undefined);
  assert.ok(Array.isArray(payload.results), "results array");
  assert.ok(payload.results.length > 0, "at least one result");
  const first = payload.results[0];
  assert.equal(typeof first.url, "string");
  assert.ok(first.url.startsWith("http"), `url looks real: ${first.url}`);
  assert.ok(Array.isArray(first.highlights) && first.highlights.length > 0, "highlights present");
  return payload;
});
if (search) {
  console.log(`       -> ${search.results.length} results, first: ${search.results[0].url}`);
}

await check("filters reach Exa and narrow the results", async () => {
  const payload = await client.search(
    { query: "async rust", numResults: 3, type: "auto", includeDomains: ["docs.rs"], contents: { highlights: true } },
    undefined,
  );
  assert.ok(payload.results.length > 0, "docs.rs has results");
  for (const result of payload.results) assert.ok(result.url.includes("docs.rs"), `stayed on docs.rs: ${result.url}`);
});

await check("an unsupported option is refused, not silently dropped", async () => {
  await assert.rejects(
    () => client.search({ query: "x", type: "deep", contents: { highlights: true } }, undefined),
    /keyless mode cannot honor type=deep/,
  );
});

console.log("\ncontents");
await check("reads one URL", async () => {
  const payload = await client.contents({ urls: ["https://example.com"], text: { maxCharacters: 2000 } }, undefined);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.statuses[0].status, "success");
  assert.ok(payload.results[0].text.length > 0, "text present");
  console.log(`       -> title: ${payload.results[0].title}`);
});

await check("a dead URL reports an error status instead of throwing", async () => {
  const payload = await client.contents({ urls: ["https://example.com/definitely-not-a-page-xyz"] }, undefined);
  assert.equal(payload.results.length, 0);
  assert.equal(payload.statuses[0].status, "error");
  console.log(`       -> error tag: ${payload.statuses[0].error?.tag}`);
});

console.log("\ncode context");
await check("returns library documentation", async () => {
  const payload = await client.codeContext("Python requests POST JSON body", 3, undefined);
  assert.equal(typeof payload.text, "string");
  assert.ok(payload.text.length > 100, "substantial text");
  console.log(`       -> ${payload.text.length} chars`);
});

console.log("\nkeyed-only operations refuse with an actionable message");
for (const [label, fn] of [
  ["answer", () => client.answer({ query: "x" }, undefined)],
  ["findSimilar", () => client.findSimilar({ url: "https://example.com" }, undefined)],
  ["createRun", () => client.createRun({ query: "x" }, undefined)],
  ["getRun", () => client.getRun("abc", undefined)],
]) {
  await check(`${label} names EXA_API_KEY`, async () => {
    await assert.rejects(fn, /EXA_API_KEY/);
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall live checks passed");
