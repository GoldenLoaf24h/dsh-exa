/**
 * The Exa settings page, shown on this bundle's page in the Plugins settings.
 *
 * Every field it edits is a live field of the host plugin's config, so a save
 * applies to the next search without reloading anything. The API key is the one
 * exception: it is written to the credentials plane, which is where the plugin
 * looks for `EXA_API_KEY` after its own config, and never into a patch file.
 */
window.__ModuleLoader__.load({
  id: "dsh-exa",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { createElement: h } = require("react");
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsSecretField,
      SettingsValueField,
      Switch,
      settingsNumberField,
      settingsTextField,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    /** The loader row id this bundle declares; the settings namespace is that id. */
    const ROW_ID = "web-exa";
    /** The package name; the Plugins page keys this bundle's page by it. */
    const PACKAGE_NAME = "dsh-exa";
    const NS = "dsh-exa-settings";
    const KEY_REF = "EXA_API_KEY";

    const zh = {
      title: "Exa 搜索",
      description: "把 DSH 的 web_search 与 web_fetch 接到 Exa，并提供 exa_search 等六个工具。",
      apiKey: "Exa API Key",
      apiKeyHint: "留空表示沿用已保存的密钥。密钥写入凭证库，不会写进任何配置文件。",
      apiKeyConfigured: "已配置",
      apiKeyMissing: "未配置，将使用 Exa 的免费匿名服务",
      sectionSearch: "搜索默认值",
      searchType: "搜索模式",
      searchTypeHint: "auto（默认）、lite、deep-lite、deep、instant 或 fast",
      searchCategory: "分类",
      searchCategoryHint: "可选：company、research paper、news、github、tweet、personal site 等",
      searchIncludeDomains: "只搜这些域名",
      searchIncludeDomainsHint: "用英文逗号分隔，留空表示不限",
      searchExcludeDomains: "排除这些域名",
      searchExcludeDomainsHint: "用英文逗号分隔，留空表示不排除",
      searchMaxAgeHours: "缓存新鲜度（小时）",
      searchMaxAgeHoursHint: "留空表示由 Exa 决定；0 表示每次重新抓取，-1 表示只用缓存",
      searchHighlights: "返回高亮片段",
      searchHighlightsHint: "作为每条结果的摘要，关掉会只剩标题",
      searchText: "同时返回网页正文",
      searchTextHint: "结果里带全文，会明显增加 token",
      searchSummary: "同时返回逐条摘要",
      sectionFetch: "抓取默认值",
      fetchMaxCharacters: "每次抓取的最大字符数",
      fetchMaxAgeHours: "缓存新鲜度（小时）",
      fetchMaxAgeHoursHint: "留空表示由 Exa 决定；0 表示每次重新抓取，-1 表示只用缓存",
      sectionTools: "启动即暴露的工具",
      toolSearch: "exa_search",
      toolSearchHint: "带域名、日期、分类筛选与正文的高级检索。默认关闭，由 exa_tools 按需开启",
      toolContents: "exa_contents",
      toolContentsHint: "按 URL 批量取正文、摘要与高亮",
      toolAnswer: "exa_answer",
      toolAnswerHint: "让 Exa 直接给出带引用的答案（需要 API Key）",
      toolSimilar: "exa_similar",
      toolSimilarHint: "找出与给定页面相似的页面（需要 API Key）",
      toolCodeContext: "exa_code_context",
      toolCodeContextHint: "检索库与 API 的代码示例",
      toolResearch: "exa_research",
      toolResearchHint: "多来源深调研，耗时较长（需要 API Key）",
      sectionConnection: "连接",
      baseURL: "REST 地址",
      mcpURL: "MCP 地址",
      mcpURLHint: "没有可用 API Key 时使用的免费匿名端点",
      timeoutMs: "单次请求超时（毫秒）",
      overridden: "已修改",
      reset: "恢复默认",
      invalidNumber: "请输入数字",
      unavailable: "该插件的配置当前不可用。",
      readOnly: "该配置当前只读。",
      saveFailed: "保存失败，请查看日志。",
      save: "保存",
      saving: "保存中…",
    };

    const en = {
      title: "Exa search",
      description: "Points web_search and web_fetch at Exa and adds six exa_* tools.",
      apiKey: "Exa API key",
      apiKeyHint: "Leave blank to keep the saved key. The key is stored in the credentials store, never in a config file.",
      apiKeyConfigured: "Configured",
      apiKeyMissing: "Not configured; the keyless Exa service will be used",
      sectionSearch: "Search defaults",
      searchType: "Search mode",
      searchTypeHint: "auto (default), lite, deep-lite, deep, instant or fast",
      searchCategory: "Category",
      searchCategoryHint: "Optional: company, research paper, news, github, tweet, personal site, …",
      searchIncludeDomains: "Only these domains",
      searchIncludeDomainsHint: "Comma separated; blank means no restriction",
      searchExcludeDomains: "Never these domains",
      searchExcludeDomainsHint: "Comma separated; blank means no exclusion",
      searchMaxAgeHours: "Cache age (hours)",
      searchMaxAgeHoursHint: "Blank lets Exa decide; 0 always refetches, -1 uses the cache only",
      searchHighlights: "Return highlights",
      searchHighlightsHint: "They become each result's snippet; turning this off leaves titles only",
      searchText: "Also return page text",
      searchTextHint: "Full text per result; costs a lot of tokens",
      searchSummary: "Also return per-result summaries",
      sectionFetch: "Fetch defaults",
      fetchMaxCharacters: "Characters per fetched page",
      fetchMaxAgeHours: "Cache age (hours)",
      fetchMaxAgeHoursHint: "Blank lets Exa decide; 0 always refetches, -1 uses the cache only",
      sectionTools: "Tools exposed at startup",
      toolSearch: "exa_search",
      toolSearchHint: "Search with domain, date and category filters plus page text",
      toolContents: "exa_contents",
      toolContentsHint: "Batch fetch text, summaries and highlights by URL",
      toolAnswer: "exa_answer",
      toolAnswerHint: "A cited answer instead of sources (needs an API key)",
      toolSimilar: "exa_similar",
      toolSimilarHint: "Pages similar to a given one (needs an API key)",
      toolCodeContext: "exa_code_context",
      toolCodeContextHint: "Code and API examples",
      toolResearch: "exa_research",
      toolResearchHint: "Multi-source research; slow (needs an API key)",
      sectionConnection: "Connection",
      baseURL: "REST base URL",
      mcpURL: "MCP endpoint",
      mcpURLHint: "The free anonymous endpoint used when no API key resolves",
      timeoutMs: "Request timeout (ms)",
      overridden: "Changed",
      reset: "Reset",
      invalidNumber: "Enter a number",
      unavailable: "This plugin's configuration is not available right now.",
      readOnly: "This configuration is read-only right now.",
      saveFailed: "Saving failed; see the logs.",
      save: "Save",
      saving: "Saving…",
    };

    /** A comma separated list of domains. An empty list clears the filter. */
    const settingsListField = (field) => ({
      field,
      format: (value) => (Array.isArray(value) ? value.join(", ") : ""),
      parse: (text) => {
        const items = String(text)
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        return items.length === 0 ? { kind: "clear" } : { kind: "set", value: items };
      },
    });

    /** A switch. The form model stages plain text, so a switch is "on" or "off". */
    const settingsBooleanField = (field) => ({
      field,
      format: (value) => (value === true ? "on" : "off"),
      parse: (text) => (text === "on" ? { kind: "set", value: true } : text === "off" ? { kind: "set", value: false } : undefined),
    });

    const FIELDS = [
      settingsTextField("searchType"),
      settingsTextField("searchCategory"),
      settingsListField("searchIncludeDomains"),
      settingsListField("searchExcludeDomains"),
      settingsNumberField("searchMaxAgeHours"),
      settingsBooleanField("searchHighlights"),
      settingsBooleanField("searchText"),
      settingsBooleanField("searchSummary"),
      settingsNumberField("fetchMaxCharacters"),
      settingsNumberField("fetchMaxAgeHours"),
      settingsBooleanField("toolSearch"),
      settingsBooleanField("toolContents"),
      settingsBooleanField("toolAnswer"),
      settingsBooleanField("toolSimilar"),
      settingsBooleanField("toolCodeContext"),
      settingsBooleanField("toolResearch"),
      settingsTextField("baseURL"),
      settingsTextField("mcpURL"),
      settingsNumberField("timeoutMs"),
    ];

    class ExaSettingsController {
      ctx;
      scope;
      form;
      store;
      credentialRef = KEY_REF;
      credentialConfigured = false;
      credentialWritable = true;
      subscriptions = [];

      constructor(ctx, scope) {
        this.ctx = ctx;
        this.scope = scope;
        this.form = new SettingsFormModel(scope, FIELDS, [{ field: "apiKey", write: (text) => this.writeKey(text) }]);
        this.store = createSnapshotStore(this.projection());
        this.subscriptions.push(this.form.bind(() => this.form.shell()).subscribe(() => this.publish()));
        this.subscriptions.push(scope.subscribe(() => this.readCredential()));
      }

      /** The snapshot the page reads. */
      projection() {
        const field = (name) => this.form.field(name);
        return {
          ...this.form.shell(),
          apiKey: field("apiKey"),
          apiKeyConfigured: this.credentialConfigured,
          apiKeyWritable: this.credentialWritable,
          apiKeyRef: this.credentialRef,
          searchType: field("searchType"),
          searchCategory: field("searchCategory"),
          searchIncludeDomains: field("searchIncludeDomains"),
          searchExcludeDomains: field("searchExcludeDomains"),
          searchMaxAgeHours: field("searchMaxAgeHours"),
          searchHighlights: field("searchHighlights"),
          searchText: field("searchText"),
          searchSummary: field("searchSummary"),
          fetchMaxCharacters: field("fetchMaxCharacters"),
          fetchMaxAgeHours: field("fetchMaxAgeHours"),
          toolSearch: field("toolSearch"),
          toolContents: field("toolContents"),
          toolAnswer: field("toolAnswer"),
          toolSimilar: field("toolSimilar"),
          toolCodeContext: field("toolCodeContext"),
          toolResearch: field("toolResearch"),
          baseURL: field("baseURL"),
          mcpURL: field("mcpURL"),
          timeoutMs: field("timeoutMs"),
        };
      }

      publish() {
        this.store.set(this.projection());
      }

      /** Which credential reference the plugin will resolve, as the config now stands. */
      credentialRefOf(snapshot) {
        const configured = snapshot?.value?.apiKeyEnv;
        return typeof configured === "string" && configured.length > 0 ? configured : KEY_REF;
      }

      async readCredential() {
        const ref = this.credentialRefOf(this.scope.getSnapshot());
        this.credentialRef = ref;
        const response = await this.ctx.remote.credentials.describe([ref]);
        if (!response.ok) return;
        const view = response.value?.[ref];
        const configured = view?.configured === true;
        const writable = view?.writable !== false;
        if (configured === this.credentialConfigured && writable === this.credentialWritable) return;
        this.credentialConfigured = configured;
        this.credentialWritable = writable;
        this.publish();
      }

      async writeKey(value) {
        const response = await this.ctx.remote.credentials.set(this.credentialRef, value);
        if (!response.ok) return false;
        await this.readCredential();
        return true;
      }

      /** Re-read the key badge after the credentials plane changes underneath us. */
      refreshCredential(changed) {
        if (changed === undefined || changed === this.credentialRef) this.readCredential();
      }

      inject() {
        const actions = this.form.actions();
        return {
          hooks: { exaSettings: this.store },
          edit: actions.edit,
          resetField: actions.resetField,
          setSwitch: (field, on) => actions.edit(field, on ? "on" : "off"),
          save: actions.save,
          discard: actions.discard,
        };
      }

      dispose() {
        for (const unsubscribe of this.subscriptions) unsubscribe();
        this.subscriptions.length = 0;
        this.form.dispose();
      }
    }

    function ExaSettingsCard(props) {
      const t = props.t ?? ((key) => zh[key] ?? key);
      const state = props.useExaSettings((snapshot) => snapshot);
      if (props.view === "summary") return t("description");

      const disabled = !state.writable || state.saving;
      const field = (name, label, hint, extra) =>
        h(SettingsValueField, {
          id: `dsh-exa-${name}`,
          label: t(label),
          hint: hint === undefined ? undefined : t(hint),
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          invalidLabel: t("invalidNumber"),
          numeric: extra?.numeric === true,
          disabled,
          ...state[name],
          onEdit: (text) => props.edit(name, text),
          onReset: () => props.resetField(name),
        });

      const toggle = (name, label, hint) =>
        h(
          "div",
          { key: name, style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", padding: "10px 0" } },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            h("span", { style: { fontWeight: 500 } }, t(label)),
            hint === undefined ? null : h("span", { style: { opacity: 0.65, fontSize: "0.92em" } }, t(hint)),
          ),
          h(Switch, {
            checked: state[name].text === "on",
            disabled,
            onChange: (on) => props.setSwitch(name, on),
          }),
        );

      const section = (title, children) =>
        h(
          "section",
          { style: { display: "flex", flexDirection: "column", gap: "4px", paddingBottom: "8px" } },
          h("h3", { style: { margin: "16px 0 4px", fontSize: "0.95em", fontWeight: 600, opacity: 0.85 } }, t(title)),
          children,
        );

      return h(
        SettingsForm,
        {
          labels: {
            unavailable: t("unavailable"),
            readOnly: t("readOnly"),
            saveFailed: t("saveFailed"),
            save: t("save"),
            saving: t("saving"),
          },
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        section("sectionSearch", [
          h(SettingsSecretField, {
            key: "apiKey",
            id: "dsh-exa-apiKey",
            label: t("apiKey"),
            hint: t("apiKeyHint"),
            disabled: disabled || !state.apiKeyWritable,
            text: state.apiKey.text,
            configured: state.apiKeyConfigured,
            stateLabel: state.apiKeyConfigured ? t("apiKeyConfigured") : t("apiKeyMissing"),
            onEdit: (text) => props.edit("apiKey", text),
          }),
          field("searchType", "searchType", "searchTypeHint"),
          field("searchCategory", "searchCategory", "searchCategoryHint"),
          field("searchIncludeDomains", "searchIncludeDomains", "searchIncludeDomainsHint"),
          field("searchExcludeDomains", "searchExcludeDomains", "searchExcludeDomainsHint"),
          field("searchMaxAgeHours", "searchMaxAgeHours", "searchMaxAgeHoursHint", { numeric: true }),
          toggle("searchHighlights", "searchHighlights", "searchHighlightsHint"),
          toggle("searchText", "searchText", "searchTextHint"),
          toggle("searchSummary", "searchSummary"),
        ]),
        section("sectionFetch", [
          field("fetchMaxCharacters", "fetchMaxCharacters", undefined, { numeric: true }),
          field("fetchMaxAgeHours", "fetchMaxAgeHours", "fetchMaxAgeHoursHint", { numeric: true }),
        ]),
        section("sectionTools", [
          toggle("toolSearch", "toolSearch", "toolSearchHint"),
          toggle("toolContents", "toolContents", "toolContentsHint"),
          toggle("toolAnswer", "toolAnswer", "toolAnswerHint"),
          toggle("toolSimilar", "toolSimilar", "toolSimilarHint"),
          toggle("toolCodeContext", "toolCodeContext", "toolCodeContextHint"),
          toggle("toolResearch", "toolResearch", "toolResearchHint"),
        ]),
        section("sectionConnection", [
          field("baseURL", "baseURL"),
          field("mcpURL", "mcpURL", "mcpURLHint"),
          field("timeoutMs", "timeoutMs", undefined, { numeric: true }),
        ]),
      );
    }

    /** Every service this page needs. */
    const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "dsh-exa: settings copy",
      );

      const card = new ExaSettingsController(ctx, ctx.configForms.get(ROW_ID));
      ctx.effect(
        () => () => card.dispose(),
        "dsh-exa: settings controller",
      );
      ctx.effect(
        () => ctx.remote.$on("credentials/reference-updated", (ref) => card.refreshCredential(ref)),
        "dsh-exa: settings key badge",
      );
      card.readCredential();
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ROW_ID], () =>
            ctx.slots.inject("plugins.bundle.config", () =>
              ctx.slots.register(
                {
                  name: "plugins.bundle.config",
                  key: PACKAGE_NAME,
                  label: () => t("title"),
                  locale: NS,
                  inject: () => card.inject(),
                },
                ExaSettingsCard,
              ),
            ),
          ),
        "dsh-exa: settings page",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ExaSettingsCard = ExaSettingsCard;
    return module.exports;
  },
});
