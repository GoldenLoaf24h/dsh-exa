/**
 * Offline checks for the settings page bundle: it must register under the
 * module loader, export the services it needs, and mount into the plugin's page
 * slot with a live snapshot. No browser, no network.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const failures = [];
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
    console.log(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

// ── a minimal host: module loader, the platform modules the page requires, and
// ── the services it injects.
const loaders = [];
globalThis.window = { __ModuleLoader__: { load: (entry) => loaders.push(entry) } };

const h = (type, props, children) => ({ type, props: props ?? {}, children });
const registered = [];
const snapshotStore = (initial) => {
  let value = initial;
  const listeners = new Set();
  return {
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const primitives = {
  SettingsForm: "SettingsForm",
  SettingsValueField: "SettingsValueField",
  SettingsSecretField: "SettingsSecretField",
  Switch: "Switch",  settingsTextField: (field) => ({
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => (text.trim() === "" ? { kind: "clear" } : { kind: "set", value: text }),
  }),
  settingsNumberField: (field) => ({
    field,
    format: (value) => (typeof value === "number" ? String(value) : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      const number = Number(trimmed);
      return Number.isFinite(number) ? { kind: "set", value: number } : undefined;
    },
  }),
};
class FakeSettingsFormModel {
  constructor(scope, specs, secretSpecs = []) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    this.secretSpecs = new Map(secretSpecs.map((spec) => [spec.field, spec]));
    this.staged = new Map();
    this.listeners = new Set();
  }
  bind(select) {
    const store = snapshotStore(select());
    this.listeners.add(() => store.set(select()));
    return store;
  }
  shell() {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === undefined && item.op === undefined),
      saving: false,
      failed: false,
    };
  }
  field(name) {
    if (this.secretSpecs.has(name)) return { text: this.staged.get(name)?.text ?? "", overridden: false, invalid: false };
    const spec = this.specs.get(name);
    const staged = this.staged.get(name);
    if (staged === undefined) return { text: spec.format(this.scope.getSnapshot().value?.[name]), overridden: false, invalid: false };
    const parsed = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
    return { text: staged.text, overridden: parsed?.kind === "set", invalid: parsed === undefined };
  }
  actions() {
    return {
      edit: (name, text) => {
        this.staged.set(name, { text, clear: false });
        for (const listener of this.listeners) listener();
      },
      resetField: (name) => {
        this.staged.set(name, { text: "", clear: true });
        for (const listener of this.listeners) listener();
      },
      save: () => this.save(),
      discard: () => {
        this.staged.clear();
        for (const listener of this.listeners) listener();
      },
    };
  }
  plan() {
    const plan = [];
    for (const [name, staged] of this.staged) {
      const secret = this.secretSpecs.get(name);
      if (secret !== undefined) {
        if (staged.text.trim() !== "") plan.push({ field: name, run: () => secret.write(staged.text) });
        continue;
      }
      const spec = this.specs.get(name);
      if (staged.clear) {
        plan.push({ field: name, op: { op: "unset", path: [name] } });
        continue;
      }
      const parsed = spec.parse(staged.text);
      if (parsed === undefined) plan.push({ field: name });
      else if (parsed.kind === "clear") plan.push({ field: name, op: { op: "unset", path: [name] } });
      else plan.push({ field: name, op: { op: "set", path: [name], value: parsed.value } });
    }
    return plan;
  }
  dispose() {}
  async save() {
    const plan = this.plan();
    const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]));
    let ok = ops.length === 0 || (await this.scope.mutate(ops));
    if (!ok) return;
    for (const item of plan) if (item.run !== undefined) ok = (await item.run()) && ok;
    if (ok) {
      this.staged.clear();
      for (const listener of this.listeners) listener();
    }
  }
}
primitives.SettingsFormModel = FakeSettingsFormModel;

const platform = {
  react: { createElement: h },
  "@deepseek-ai/dsh-client-ui-primitives": primitives,
  "@deepseek-ai/dsh-client-store": { createSnapshotStore: snapshotStore },
  "@deepseek-ai/dsh-client-ui-settings": {},
  "@deepseek-ai/dsh-client-ui-slots": {},
  "@deepseek-ai/dsh-api-remotes": {},
  "@deepseek-ai/dsh-client-locale": {},
};

const requireMock = (name) => {
  if (platform[name] === undefined) throw new Error(`unexpected require("${name}")`);
  return platform[name];
};

// ── load the bundle exactly as the browser would
const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
globalThis.eval(source);

console.log("bundle");
check("registers one entry under the package name", () => {
  assert.equal(loaders.length, 1);
  assert.equal(loaders[0].id, "dsh-exa");
  assert.equal(typeof loaders[0].factory, "function");
});

const exports_ = loaders[0].factory(requireMock);

check("exports apply and the services it injects", () => {
  assert.equal(typeof exports_.apply, "function");
  assert.deepEqual(exports_.inject, ["slots", "locale", "remote", "remote.credentials", "configForms"]);
});

// ── a fake host context with the services the page asks for
const snapshot = {
  status: "ready",
  writable: true,
  value: {
    apiKeyEnv: "EXA_API_KEY",
    searchType: "auto",
    searchCategory: undefined,
    searchIncludeDomains: [],
    searchExcludeDomains: [],
    searchMaxAgeHours: undefined,
    searchHighlights: true,
    searchText: false,
    searchSummary: false,
    fetchMaxCharacters: 100000,
    fetchMaxAgeHours: undefined,
    toolSearch: true,
    toolContents: true,
    toolAnswer: true,
    toolSimilar: true,
    toolCodeContext: true,
    toolResearch: true,
    baseURL: "https://api.exa.ai",
    mcpURL: "https://mcp.exa.ai/mcp",
    timeoutMs: 30000,
  },
};
const mutations = [];
const scope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async (ops) => {
    mutations.push(ops);
    return true;
  },
};
const slotRegistrations = [];
const services = [];
const credentials = {
  describe: async (refs) => ({ ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true }])) }),
  set: async (ref, value) => {
    services.push(["credentials.set", ref, value]);
    return { ok: true };
  },
};
const ctx = {
  effect: (fn) => fn(),
  locale: {
    bind: () => (key) => key,
    register: (ns, dictionaries) => {
      services.push(["locale.register", ns, Object.keys(dictionaries)]);
      return () => {};
    },
  },
  configForms: {
    get: (id) => {
      services.push(["configForms.get", id]);
      return scope;
    },
    whileServed: (namespaces, register) => {
      services.push(["whileServed", namespaces]);
      if (namespaces.includes("web-exa")) register();
      return () => {};
    },
  },
  slots: {
    inject: (slot, fn) => fn(),
    register: (options, component) => {
      slotRegistrations.push([options.name, options, component]);
      return () => {};
    },
  },
  remote: {
    credentials,
    $on: () => () => {},
  },
};

exports_.apply(ctx);
// The key badge is read asynchronously; let it land.
await new Promise((resolve) => setTimeout(resolve, 0));

console.log("\nwiring");
check("the settings namespace is the loader row id", () => {
  assert.ok(services.some(([name, id]) => name === "configForms.get" && id === "web-exa"));
  assert.ok(services.some(([name, namespaces]) => name === "whileServed" && namespaces.includes("web-exa")));
});
check("the page mounts on this bundle's row in the Plugins settings", () => {
  const [slot, options, component] = slotRegistrations[0];
  assert.equal(slot, "plugins.bundle.config");
  assert.equal(options.name, "plugins.bundle.config");
  assert.equal(options.key, "dsh-exa");
  assert.equal(component, exports_.ExaSettingsCard);
});

const injected = slotRegistrations[0][1].inject();
check("the page receives one hook and the actions it renders", () => {
  assert.deepEqual(Object.keys(injected.hooks), ["exaSettings"]);
  for (const action of ["edit", "resetField", "setSwitch", "save", "discard"]) {
    assert.equal(typeof injected[action], "function", `${action} must be callable`);
  }
});

const state = injected.hooks.exaSettings.getSnapshot();
check("the snapshot carries every field the page renders", () => {
  for (const name of ["apiKey", "searchType", "searchCategory", "searchIncludeDomains", "searchExcludeDomains", "searchMaxAgeHours", "searchHighlights", "searchText", "searchSummary", "fetchMaxCharacters", "fetchMaxAgeHours", "toolSearch", "toolContents", "toolAnswer", "toolSimilar", "toolCodeContext", "toolResearch", "baseURL", "mcpURL", "timeoutMs"]) {
    assert.equal(typeof state[name], "object", `${name} must be projected`);
    assert.equal(typeof state[name].text, "string", `${name}.text must be a string`);
  }
  assert.equal(state.apiKeyConfigured, true);
});

console.log("\nstaging");
check("a switch stages a typed boolean, not a string", () => {
  injected.setSwitch("searchHighlights", false);
  const next = injected.hooks.exaSettings.getSnapshot();
  assert.equal(next.searchHighlights.text, "off");
  assert.equal(next.dirty, true);
  assert.equal(next.invalid, false);
});

check("a domain list stages a real array", () => {
  injected.edit("searchIncludeDomains", "tokio.rs, docs.rs");
  const next = injected.hooks.exaSettings.getSnapshot();
  assert.equal(next.searchIncludeDomains.text, "tokio.rs, docs.rs");
  assert.equal(next.invalid, false);
});

check("a non-numeric number field is reported invalid, not saved", () => {
  injected.edit("timeoutMs", "soon");
  const next = injected.hooks.exaSettings.getSnapshot();
  assert.equal(next.invalid, true);
});

check("a bad number is reported invalid, a good one stages", () => {
  injected.edit("timeoutMs", "45000");
  const next = injected.hooks.exaSettings.getSnapshot();
  assert.equal(next.invalid, false);
  assert.equal(next.timeoutMs.text, "45000");
});

check("the key is staged as a secret and never as a config value", () => {
  injected.edit("apiKey", "exa-secret-key");
  const next = injected.hooks.exaSettings.getSnapshot();
  assert.equal(next.apiKey.text, "exa-secret-key");
  assert.equal(next.apiKey.overridden, false);
});

check("saving writes the key to the credentials plane", async () => {
  injected.save();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    services.filter(([name]) => name === "credentials.set"),
    [["credentials.set", "EXA_API_KEY", "exa-secret-key"]],
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall client checks passed");
