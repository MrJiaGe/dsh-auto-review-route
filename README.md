# @mrjiage/dsh-auto-review-route

让 DeepSeek Harness 的**自动审查（Auto review）**把审查请求发往你指定的主渠道与模型，避免和工作模型争用同一并发额度，并可在主路线失败后切换到回退模型；重试默认关闭且次数可配置。使用非官方直连 API 时，若上游对请求进行严重的提示词注入、改写或其他干扰，可能影响审查结果甚至导致调用失败；此类上游行为不受本插件控制。可选的审查理由语言设置默认关闭；选中后只要求模型改变理由文字语言，不修改官方风险策略或 JSON 协议。

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

上面说的是官方插件自身。本第三方插件在公开的 `llm/stream` waterfall 外围提供可选重试和失败回退；不修改官方包。

## 它怎么做到不改官方代码

官方那次审查调用走的是公开的 `llm/stream` waterfall，而官方自己的契约里写明该事件的用途包含 **routing**：

```
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next) → AsyncIterable<StreamChunk>
"Waterfall around every streaming model call (retry, replay, routing)."
```

本插件只在这一层识别审查请求：可选地替换主路由，或在主路由用尽尝试后切换到回退路由；用户显式选择理由语言时才在官方提示词末尾追加一条有限指令。默认不追加提示词，也不启用回退或自动重试；官方包、风险决策、消息、工具、温度和生命周期保持不变。自动重试启用时，设置次数表示每条路线首次请求之后的额外尝试数；主路线耗尽后回退路线获得同样的重试预算。重试关闭但回退开启时，主路线第一次可重试失败后立即尝试回退路线。回退渠道与模型都留空时使用会话路由；用户取消和符合协议的正常响应不触发重试/回退；无效 finish、内容块结构或决策 JSON 会按各自路线预算重试，并在启用时回退。失败尝试的部分流会丢弃，只向官方判定器交付最终路线的最终尝试。

识别条件（全部都是官方审查调用的独有特征，且同时排除其他调用）：

| 条件 | 为什么安全 |
|---|---|
| `system` 以 `REVIEW_POLICY` 开头 | 官方固定的审查提示词首行（`lib/index.js:20`） |
| `temperature === 0` | 官方审查固定 0 |
| `tools === undefined` | 审查请求不带工具 |
| `purpose === undefined` | compaction 带 `'compaction'`、标题生成带 `'session-title'`，天然排除 |

## 明确不做的事

- **不预置默认渠道/模型。** 主 provider/model 留空时不接管主路由；回退 provider/model 留空时使用会话路由。reasonLanguage 留空时对审查提示词完全惰性。
- **自动重试与回退默认关闭。** 启用自动重试后，`retryAttempts` 表示每条路线首次请求之后的额外尝试次数（1–5，默认 2）。若同时启用回退，主路线耗尽后回退路线获得同样预算，最多产生 `2 × (retryAttempts + 1)` 次请求（次数为 5 时最多 12 次）；若重试关闭但回退开启，则首次可重试失败后只尝试一次回退。用户取消和有效响应不会重试/回退；非 stop finish、无效内容块或决策 JSON 会消耗该路线预算，每次请求都可能产生额外用量。
- **默认不改官方提示词。** 只有显式选择理由语言时，才在原 `system` 末尾追加固定语言指令；它只约束可选 `reason` 文本，不改风险分类、决策或 JSON 协议。`messages`、`temperature`、`signal`、工具和生命周期始终原样保留。
- **配错不会挡工作。** 主渠道或模型不可用时，若回退开关启用则切到回退路线；否则使用会话路由。回退路线不可用时也使用会话路由，并记录一次诊断日志。
- **回退渠道与模型必须成对配置。** 两项都空代表会话模型；只配置一项会被设置页和 Host bridge 拒绝。回退开关默认关闭，关闭时保留配置但不使用。
- **不新增会话事件、不写磁盘、不改官方包。** 插件自身不写独立配置文件；UI 保存的配置由 DSH 的 profile 配置系统管理。
- **卸载说明。** 通过 DSH 插件管理器卸载后，插件包和插件行会被移除，但 profile 配置文件中由用户保存的该插件配置可能保留。通常这不会影响 DSH；若要彻底清理，请在卸载后打开当前 profile 的 `cordis.patch.yml`，删除 `auto-review-route` 对应的配置项，再重启 DSH。

## 配置项

都在 profile 的 `cordis.patch.yml`，同时也都能在 UI 里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `""` | 主审查渠道。空 = 使用会话路由 |
| `model` | `""` | 主渠道上的模型 ID。空 = 使用会话路由 |
| `fallbackEnabled` | `false` | 主路线用尽可重试尝试后切换回退路线；重试关闭时在首次可重试失败后切换 |
| `fallbackProvider` | `""` | 回退渠道。与 `fallbackModel` 都空时使用会话模型 |
| `fallbackModel` | `""` | 回退模型 ID。渠道与模型必须同时填写或同时留空 |
| `reasoningEffort` | `""` | 可选档位；空 = 用目标模型默认。不支持的档位会被自动丢弃 |
| `reasonLanguage` | `""` | 审查理由语言；空 = 不追加提示词，`zh` = 简体中文，`en` = English。独立于 provider/model 路由 |
| `debug` | `false` | 调试日志；开启后记录审查路由、请求耗时、流结果、结构化错误和异常对象中可见的脱敏 cause，设置页可查看最近 100 条内存记录 |
| `retryEnabled` | `false` | 自动重试审查请求；主路线用尽预算后可切换回退路线，用户取消和正常响应不会触发 |
| `retryAttempts` | `2` | 每条路线首次请求后的额外尝试数，范围 `1–5`；重试 error finish、异常、缺少 finish 和无效审查结果，仅在 `retryEnabled: true` 时生效 |
| `marker` | `"REVIEW_POLICY"` | 审查提示词前缀。**只在官方改了这个标识时才需要动** |

主 provider/model 都填写后才会接管主路由；回退开关启用后，回退 provider/model 都留空表示使用会话路由。推理档位只应用于主路由，回退模型使用自身默认档位；reasonLanguage 可独立选择。理由语言留空时不修改官方提示词。

## UI

侧栏 **设置 → 插件 → dsh-auto-review-route → 配置**：

- **主渠道 / 主模型 / 回退渠道 / 回退模型**：两行两列成对排列；每个模型列表跟随对应渠道加载，拉不到时可切换手动输入 ID。回退开关默认关闭；启用后主路线耗尽重试才切换到第二组，渠道和模型都留空则回到会话模型。
- **推理档位**下拉：`off / minimal / low / medium / high / xhigh / max`，默认"跟随目标模型"。通常推理档位越低响应越快，越高需要更多推理时间；具体效果取决于目标模型。
- **审查理由语言**下拉（位于推理档位下方）：默认"保持官方提示词"；支持 `简体中文 Simplified Chinese` 和 `English`。语言指令可独立于模型路由使用，只影响可选拒绝理由，模型或上游可能不遵从。
- **自动重试**复选框和**额外重试次数**数字输入：默认关闭；范围 `1–5`，默认 2 次（不含首次请求），按每条路线分别计算。重试 error finish、抛出异常、缺少 finish，以及非 stop finish、无效内容块或决策 JSON；不重试用户取消和有效决策。回退路线获得同样的重试预算；退避期间响应取消；每次请求都可能产生额外用量。
- **自动审查调试日志**复选框：默认关闭。开启后，Host 会记录路由、首块/总耗时、chunk 类型计数、结束原因、结构化 finish failure、重试次数，以及异常对象中可见的脱敏 cause 链；如果 LLM 服务只返回通用 failure，底层 cause/status/requestId 可能不可见。错误文本限长，并移除 URL 与常见凭据字段。不会记录 prompt、消息正文或流内容。
- **最近诊断记录**：通过已认证的设置页 bridge 查看 Host 内存中最近 100 条记录，可刷新、复制或清空。记录不写磁盘，Host 重启或插件重载后清空；关闭 debug 后停止新增记录。
- **审查提示词标识**：一般不用动
- **保存 / 重置 / 改用会话模型**：保存即写回 profile patch，**即时生效**（字段都是 `.volatile()`，无需重启）

页面顶部的"当前生效路由"卡片只汇报模型路由：未指定时使用会话渠道与模型；理由语言选项可独立生效。

## 目录

```
package.json         dsh.bundle.patch + dsh.client 声明
cordis.patch.yml     插入一行，config 为空
index.js             Host：llm/stream 改道 / 诊断日志与认证 bridge
client.js            Client：plugins.row.config 配置页
locale/en.json       插件标题与描述（英文）
locale/zh.json       插件标题与描述（中文）
icon.svg             图标
verify.mjs           Host 行为回归测试
render-check.mjs     Client 页面渲染回归测试
```

## 验证

```sh
node verify.mjs
node render-check.mjs
```

覆盖：

1. 未配置时审查调用不被改道（官方行为）
2. 非审查调用（普通对话 / compaction / 会话标题 / 带工具 / 温度非 0 / 无 system）一律不碰
3. 审查调用被改道，且 `system` / `messages` / `temperature` / `signal` 原样保留，不凭空加 `tools` 或 `purpose`
4. 声明过的档位会转发
5. 渠道不存在 → 不改道 + 一条日志
6. 目标路由与会话路由相同时不重复派发
7. 主路由、回退路由和理由语言的默认值
8. 选择理由语言但不配置模型路由时，仍沿用会话模型并只追加语言指令
9. 配置理由语言也不会触碰普通对话、compaction 或标题生成
10. 主/回退路由不可用时回落到会话模型，理由语言仍可生效
11. debug 日志记录可见 cause 与结构化 finish failure，同时不记录请求/流正文并脱敏凭据
12. 消费者读到终止 finish 后提前关闭流，error 仍记为 `failed`、aborted 仍记为 `aborted`，并记录 signal 状态
13. 认证诊断 bridge 最多返回 100 条记录、拒绝未授权访问，并可清空内存缓冲
14. 自动重试隐藏失败尝试的部分流，成功后仅交付最终响应；首个 finish 后停止消费
15. 配置次数按额外派发计算，失败耗尽后交付最后一次错误；用户取消不重试，取消时的最终异常仍传播
16. 主路线耗尽后切换回退模型，回退模型独立获得同样重试预算，最终只交付最后路线的响应
17. 空回退配置使用会话模型且仍可重试；重试关闭时首个可重试失败后立即回退；取消不触发回退
18. 设置 bridge 拒绝不完整的渠道/模型对，且仅允许写入插件拥有的字段
19. Client 中英文配置页显示对称四选框、开关默认关闭、模型目录加载和成对校验，并验证窄屏网格
20. 严格校验 allow/deny JSON、重复成员、block 顺序和 stop finish；无效主结果逐路线重试/回退，回退错误及会话路线无效结果不递归，最终仍失败关闭


## 已知边界

- **识别依赖提示词前缀。** 官方若改掉 `REVIEW_POLICY` 首行，插件会静默失效（回落到官方行为，不会崩）。`marker` 可覆盖，但失效时**不会报错**——这是刻意的，宁可不生效也不能挡住审查。
- **解析器需跟随官方协议。** 本插件在释放路线结果前镜像官方决策 JSON 与 block 结构校验；官方更改这些契约时需同步更新，最终无效结果仍由官方解析器失败关闭。
- **理由语言只是提示，不是强制保证。** 目标模型或上游 API 可能忽略、覆盖该语言指令；无效 JSON 或 block 结构会按启用的重试/回退预算恢复，最终路线仍无效时官方 Auto-review 会按失败关闭。
- **改道或追加理由语言指令会让 `llm/stream` 再进一次。** 其他监听者（如 dsh-ops 的 read-dedup）会看到两次。该监听者对无 `sessionId` 的调用本来就是清空后直通，行为等价。
- **不解决配额粒度问题。** 如果限流是按 API key 或账号算的，换渠道无效；只有按渠道/模型计限流时才有意义。
- **审查请求可能较大**（带 `FILTERED_HISTORY`）。目标渠道的上下文窗口要够，否则会以 provider 错误失败。
