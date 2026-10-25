# @local/dsh-auto-review-route

让 DeepSeek Harness 的**自动审查（Auto review）**把审查请求发往你指定的渠道与模型，避免审查请求和工作模型抢同一个并发额度。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 本项目是社区维护的第三方插件，不是 DeepSeek Harness 官方组件，也不代表 DeepSeek 或其关联方。

## 开源许可

本项目采用 **MIT License**。你可以自由使用、复制、修改、合并、发布、分发、再许可和销售本项目的副本，但必须在副本或其重要部分中保留版权声明和许可证声明。完整条款见 [LICENSE](LICENSE)。

Copyright (c) 2026 DrJia

### 第三方依赖

本项目依赖 DeepSeek Harness 相关软件包及其他 npm 软件包。它们不属于本项目的 MIT 授权范围，分别受其各自的许可证和条款约束。分发本项目时，请同时遵守相关依赖包的许可证要求。

本项目不会修改官方自动审查插件，但运行时依赖 DeepSeek Harness 提供的插件接口。DeepSeek Harness、Auto review 及相关名称和标识的权利归其各自权利人所有。

### 免责声明

本项目按“现状”提供，不对可用性、准确性、兼容性或特定用途适用性作任何明示或默示保证。使用本插件切换 provider/model 可能受到服务商配额、计费、上下文窗口、网络状况和模型能力差异的影响。使用者应自行确认目标服务商的授权、隐私、数据处理和计费条款，并对自己的配置和请求承担责任。

官方插件 `@deepseek-ai/dsh-experimental-auto-review` **一个字符都不改**。

---

## 为什么需要它

官方插件把审查模型写死成"当前会话自己的模型"：

```js
// dsh-experimental-auto-review/lib/index.js:216-220
const header = session.requestHeader()
…
// :311-318
return deepFreeze({ provider: header.config.provider, model: header.config.model, … })

// :400-414
const options = deepFreeze({ provider: snapshot.provider, model: snapshot.model, … })
return readDecision(ctx.llm.stream(options))
```

而且它**没有导出 `Config`**（`lib/index.js:507` 只导出 `apply / inject / name`），所以在 `cordis.patch.yml` 里给它写 `config: { provider, model }` 不会生效、也不会报错。官方 README 的 Known Limitations 也写明了：

> "There are no deterministic tool exemptions, persistent grants, **configurable policy**, or retry layer."

## 它怎么做到不改官方代码

官方那次审查调用走的是公开的 `llm/stream` waterfall，而官方自己的契约里写明该事件的用途包含 **routing**：

```
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next) → AsyncIterable<StreamChunk>
"Waterfall around every streaming model call (retry, replay, routing)."
```

本插件只在这一层做一件事：认出"这是审查请求"，把 `provider` / `model` 换掉，再重新派发。其余一切都按原样透传。

识别条件（全部都是官方审查调用的独有特征，且同时排除其他调用）：

| 条件 | 为什么安全 |
|---|---|
| `system` 以 `REVIEW_POLICY` 开头 | 官方固定的审查提示词首行（`lib/index.js:20`） |
| `temperature === 0` | 官方审查固定 0 |
| `tools === undefined` | 审查请求不带工具 |
| `purpose === undefined` | compaction 带 `'compaction'`、标题生成带 `'session-title'`，天然排除 |

## 明确不做的事

- **不预置默认渠道/模型。** 没选 → 插件完全惰性 → 走官方行为（会话模型）。
- **不改策略、提示词、工具、生命周期。** `system`、`messages`、`temperature`、`signal` 逐字节原样转发；不注入、不删除、不重排任何内容。
- **不新增会话事件、不写磁盘、不改官方包。**
- **配错不会挡工作。** 渠道不存在、模型不可用、档位不支持 → 打一条日志后**回落到官方路由**，审查照常进行。

## 配置项

都在 profile 的 `cordis.patch.yml`，同时也都能在 UI 里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `""` | 审查用哪个渠道。空 = 不接管 |
| `model` | `""` | 该渠道上的模型 ID。空 = 不接管 |
| `reasoningEffort` | `""` | 可选档位；空 = 用目标模型默认。不支持的档位会被自动丢弃 |
| `marker` | `"REVIEW_POLICY"` | 审查提示词前缀。**只在官方改了这个标识时才需要动** |

两个必填项都填了才生效；只填一个等于没填。

## UI

侧栏 **设置 → 插件 → dsh-auto-review-route → 配置**：

- **渠道**下拉：来自 `ctx.llm.listProviders()`（`wdtn` / `workbuddy` / `deepseek-account` …）
- **模型**下拉：切换渠道后自动从 `ctx.llm.listModels(provider)` 拉取；拉不到时可切"手动输入 ID"
- **推理档位**下拉：`off / minimal / low / medium / high / xhigh / max`，默认"跟随目标模型"
- **审查提示词标识**：一般不用动
- **保存 / 重置 / 改用会话模型**：保存即写回 profile patch，**即时生效**（字段都是 `.volatile()`，无需重启）

页面顶部有"当前生效路由"卡片：未选时显示"会话渠道与模型（官方行为）"，选了才显示具体路由。

## 目录

```
package.json         dsh.bundle.patch + dsh.client 声明
cordis.patch.yml     插入一行，config 为空
index.js             Host：llm/stream 改道 + 两个只读列表接口
client.js            Client：plugins.row.config 配置页
locale/en.json       插件标题与描述（英文）
locale/zh.json       插件标题与描述（中文）
icon.svg             图标
verify.mjs           26 项行为断言
```

## 验证

```sh
node verify.mjs
```

覆盖：

1. 未配置时审查调用不被改道（官方行为）
2. 非审查调用（普通对话 / compaction / 会话标题 / 带工具 / 温度非 0 / 无 system）一律不碰
3. 审查调用被改道，且 `system` / `messages` / `temperature` / `signal` 原样保留，不凭空加 `tools` 或 `purpose`
4. 声明过的档位会转发
5. 渠道不存在 → 不改道 + 一条日志
6. 目标路由与会话路由相同时不重复派发
7. 两个路由字段默认都是空字符串

## 已知边界

- **识别依赖提示词前缀。** 官方若改掉 `REVIEW_POLICY` 首行，插件会静默失效（回落到官方行为，不会崩）。`marker` 可覆盖，但失效时**不会报错**——这是刻意的，宁可不生效也不能挡住审查。
- **改道会让 `llm/stream` 再进一次。** 其他监听者（如 dsh-ops 的 read-dedup）会看到两次。该监听者对无 `sessionId` 的调用本来就是清空后直通，行为等价。
- **不解决配额粒度问题。** 如果限流是按 API key 或账号算的，换渠道无效；只有按渠道/模型计限流时才有意义。
- **审查请求可能较大**（带 `FILTERED_HISTORY`）。目标渠道的上下文窗口要够，否则会以 provider 错误失败。
