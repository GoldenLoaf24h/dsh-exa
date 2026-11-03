# dsh-exa

把 DeepSeek Harness 的网络检索整体接到 [Exa](https://exa.ai)：`web_search` 与 `web_fetch` 由 Exa 提供，另外再加六个 `exa_*` 工具，覆盖 Exa 的高级检索能力。

- 有 `EXA_API_KEY` 时走 Exa REST API（`https://api.exa.ai`），全部能力可用。
- 没有 key 时自动退到 Exa 的托管 MCP（`https://mcp.exa.ai/mcp`），搜索、抓取、代码检索照常可用，不需要任何配置。
- 需要 key 的能力（`exa_answer`、`exa_similar`、`exa_research`、深度检索、结构化输出）在没有 key 时会给出明确的提示，而不是静默降级。

## 安装

```bash
dsh plugin --profile desktop add D:/workspace/dsh-exa/dsh-exa
```

然后在插件页面启用 `dsh-exa`。如果 profile 自己的 `cordis.patch.yml` 里写死了别的搜索 provider，把那一行改成 `exa`（见下）。

## 接管 web_search / web_fetch

插件的 `cordis.patch.yml` 已经声明：

```yaml
- id: web
  config:
    searchProvider: exa
    fetchProvider: exa
```

profile 自己的 patch 层在 bundle 层之后应用，所以**如果 profile 里也有一行 `- id: web`，它会覆盖本插件的设置**。要真正接管，profile 的 `cordis.patch.yml` 需要同步改成 `exa`：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: exa
    fetchProvider: exa
```

## 工具

`web_search`、`web_fetch` 常驻。此外默认还会暴露多源检索的核心三件套，因为它们承担的是任务开局就要用的能力：

| 工具 | 作用 | 成本 | 默认 | 需要 key |
| --- | --- | --- | --- | --- |
| `web_search` | 内置搜索，已由 Exa 接管 | — | 常驻 | 否 |
| `web_fetch` | 内置抓取，已由 Exa 接管 | — | 常驻 | 否 |
| `exa_research` | 多来源深调研，可轮询 | 366 tok | **开** | 是 |
| `exa_answer` | 带引用的综合答案 | 239 tok | **开** | 是 |
| `exa_code_context` | 库与 API 的代码示例 | 127 tok | **开** | 否 |
| `exa_tools` | 按需开启下面三个 | 172 tok | 常驻 | 否 |
| `exa_search` | 完整搜索参数：类型、分类、域名、日期、正文、摘要、结构化输出 | 1347 tok | 关 | 部分 |
| `exa_contents` | 按 URL 批量取正文、摘要、高亮、子页面 | 834 tok | 关 | 部分 |
| `exa_similar` | 找相似页面 | 1040 tok | 关 | 是 |

启动成本约 **900 token**。三个大 schema（`exa_search`/`exa_contents`/`exa_similar`，合计 3200+ token）默认不注册，因为 `web_search` 和 `web_fetch` 已经覆盖了普通检索与抓取；需要域名/日期/分类筛选或批量取正文时，模型调用 `exa_tools({ enable: ["search"] })` 再开，开了就保持到会话结束。

`exa_tools` 也能 `disable` 掉任何工具，包括默认开着的——这一轮任务不需要多源调研时，把 `research` 收起来能省 366 token。

配置页的开关决定「启动即暴露」，可以按需把三个贵的也打开，或者把默认开的关掉。

## 配置页面

插件在「设置 → 插件 → dsh-exa」有一个配置页，所有字段都是热生效的：保存后下一次请求就用新值，不需要重启。

- **API Key**：写入 DSH 凭证库（`EXA_API_KEY`），不会落到任何配置文件里。留空表示沿用已保存的 key。
- **搜索默认值**：搜索模式、分类、域名白/黑名单、缓存新鲜度、是否要高亮/正文/摘要。这些是 `web_search` 的默认值，模型仍可通过 `exa_search` 逐次覆盖。
- **抓取默认值**：单页最大字符数、缓存新鲜度。
- **工具开关**：每个 `exa_*` 工具是否**启动即暴露**。默认开 `exa_answer`、`exa_code_context`、`exa_research`，关 `exa_search`、`exa_contents`、`exa_similar`（这三个 schema 大，且 `web_search`/`web_fetch` 已覆盖常规用途）。改开关会清掉模型自己开/关的那批。
- **连接**：REST 地址、MCP 地址、单次请求超时。

## 解析顺序

API key 依次从下面三处取，先命中者生效：

1. 配置里的 `apiKey`（字面量，不推荐）
2. 凭证库中的 `EXA_API_KEY`（配置页写入的位置）
3. 启动环境里的 `EXA_API_KEY`（`$DSH_HOME/.env`、项目 `.env`、继承的环境变量）

## 开发

```bash
node test/offline.mjs   # 配置、工具 schema、keyless 参数转换、页面解析
node test/client.mjs    # 配置页的挂载、快照、暂存与保存
node test/live.mjs      # 真实调用 Exa（需要网络）
```

## 已知边界

- Exa 不返回目标页面的 HTTP 状态码。抓取成功统一记为 `200`，失败会抛出带原因的 `WebError`。
- 无 key 时 Exa 托管 MCP 有并发与频率限制，插件内做了串行化与退避重试。
- 无 key 时无法使用 `outputSchema`、`contents.extras`、`type: deep` 等仅 REST 支持的参数，会明确报错而不是忽略。
