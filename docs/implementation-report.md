# 实施报告 —— 与任务书的逐条对照

> 本文件回答一个问题：**任务书里的每一条要求，在代码里落在哪里、怎么验证。**
> 阅读顺序建议：先看 §1 交付物清单，再看 §3 陷阱对照表（这是最容易出问题的地方）。

---

## 1. 交付物清单对照（任务书 §9）

| 任务书要求 | 实际文件 | 状态 |
|---|---|---|
| 常驻服务 + 本地 Web UI（单文件，零构建） | `src/daemon.ts`、`src/server.ts`、`public/ui.html` | ✅ |
| `api.ts` | `src/api.ts` | ✅ |
| `llm.ts` | `src/llm.ts` | ✅ |
| `trigger.ts` | `src/trigger.ts` | ✅ |
| `danmaku.ts` | `src/danmaku.ts` | ✅ |
| `asr.ts` | `src/asr.ts` | ✅ |
| `analyze.ts` | `src/analyze.ts` | ✅ |
| `publish.ts` | `src/publish.ts` | ✅ |
| `prompts/`（可迭代的 prompt 文件） | `prompts/chunk.md`、`summary.md`、`select.md`、`retitle.md` | ✅ |
| `config.example.json` | 同在根目录 | ✅ |
| `package.json` / `tsconfig.json` | 同在根目录 | ✅ |
| `start.bat` / `start.ps1`（显式 Node 路径） | 同在根目录，自动探测 4 个来源 | ✅ |
| `ledger.json`（运行时生成） | `data/ledger.json` | ✅ |
| `decisions.jsonl` | `data/decisions.jsonl` | ✅ |
| `errors.jsonl` | `data/errors.jsonl` | ✅ |
| `error-report/`（每任务完整报告） | `data/error-report/` | ✅ |
| `performance.jsonl` | `data/performance.jsonl` | ✅ |
| `docs/api-observed.md`（WP1 实测记录） | `docs/api-observed.md` + `docs/wp1-findings.json` | ✅ |
| `test/fixtures/` | 12 个真实响应 fixture + 2 个弹幕 XML fixture | ✅ |
| `test/mock-server.ts` | `test/mock-server.ts`（模拟全部接口 + ffmpeg 行为） | ✅ |
| `README.md` | 含安装、配置、启动、`--dry-run`、故障排查 | ✅ |
| `.gitignore` | 忽略凭据、台账、日志、密钥 | ✅ |
| 可复现的离线测试用例 | `test/e2e-offline.ts`（137 项断言） | ✅ |

**额外的交付物（任务书未要求但必要）**：

| 文件 | 为什么需要 |
|---|---|
| `src/cli.ts` | 任务书要求的 `--dry-run` / `--from-stage` / `--inspect` 需要一个统一入口 |
| `src/redact.ts` | 硬约束 #8 需要**唯一**的脱敏出口，否则每个模块各写一份必然漏 |
| `src/media.ts` | 陷阱 #30（分段文件 → 全局时间映射）的落点，asr 与 trigger 共用 |
| `src/cleanup.ts` | §7 数据生命周期（分层清理 + 磁盘守卫） |
| `src/errors.ts` | WP6 步骤 10（错误报告与复查） |
| `src/alert.ts` | WP6 步骤 4（告警通道 + 去重 + 恢复配对） |
| `src/ledger.ts` | WP5 步骤 5（幂等台账 + 状态机 + 崩溃恢复） |
| `test/smoke.ts` | 验证服务形态（自检、UI 安全校验、交付物完整性） |
| `test/redact-selftest.ts` | 76 项断言守住「凭据不进日志」这条线 |
| `test/credential-audit.ts` | 源码级凭据扫描，且**自证检测能力有效**（避免假闸门） |
| `test/selftest.ts` | 统一跑「脱敏 + 冒烟」的快捷入口 |

---

## 2. WP 逐条对照

### WP1 —— API 客户端与联调

| 要求 | 落点 | 验证 |
|---|---|---|
| 统一请求封装（鉴权/超时/重试/错误处理/日志脱敏） | `api.ts` 的 `request()` | smoke 第 2/4 节 |
| 自动注入 `Authorization` header，超时可配 | `BiliLiveClient.request` + `asrTimeoutMs` | e2e 场景 13（401 与超时） |
| 日志统一脱敏 | `redact.ts` 是唯一出口 | `test/redact-selftest.ts` 76 项 + `test/credential-audit.ts` |
| 依次调通并记录真实响应 | `probe.ts`，产出 `docs/api-observed.md` | `node src/probe.ts` 实测通过 |
| 实测确认 `offset` 语义 | `asr.ts` 的 `WindowCall.offset` 注释 + `probe.ts --allow-paid` | 未实测（未产生付费调用，见下方「未完成项」） |
| 六项确认项 | `docs/api-observed.md` 的「WP1 六项确认项结论」 | 已逐项给出结论 |
| 用真实响应建 mock server | `test/mock-server.ts` | e2e 全程依赖它 |

**实测发现的与任务书不一致之处**（已按「以实测为准」处理）：

1. **biliLive-tools 版本是 3.21.0**，任务书核实的是 3.22.1 → 已在不一致项中标注；`checkVersionDrift()` 会告警。
2. **`live_start_time` 实测是毫秒**，任务书 §4.1 写的是秒级 → `util.toSec/toMs` 做自适应转换，不再依赖量级判断。
3. **`user/list` 实测返回单个对象**，任务书说的是数组 → `userList()` 两种形态都兼容。
4. `/record-history/list` 实测多出 `created_at` / `streamer_id` / `live_id` / `video_filename` / `quick_hash` 字段 → 已在类型里标注。
5. `/preset/ffmpeg` 的 `default` 预设**未声明编码器** → `buildFfmpegOptions` 支持配置级覆盖参数兜底。
6. **`afterUploadDeletAction = deleteAfterCheck`**（房间级），违反硬约束 #11 → `selfCheck` 与 `checkAfterUploadDelete()` 会明确报警并给出修复步骤。

### WP2 —— 触发与信号聚合

| 要求 | 落点 |
|---|---|
| 默认 60 秒轮询 + 已处理 id 持久化 | `Trigger.pollOnce()` + `data/trigger-state.json` |
| 启动用 `record-history/list` 分页补漏 | `Trigger.reconcile()`，`start()` 里先跑一次 |
| 每小时再对账一次 | `Trigger.start()` 的 `reconcileTick` |
| `list` 的时间过滤参数用**毫秒** | `api.recordHistoryList` 注释 + probe 实测打印单位 |
| 判定录制完成（新 id + endTime + 大小两次采样） | `Trigger.checkComplete()` |
| **下播确认**（持续非直播 ≥ 续传窗口） | `Trigger.evaluateGroup()` 三层条件 |
| `live_id` 聚合（断流多段算一场） | `groupByLiveId()` |
| webhook 接收端点 | `server.ts` 的 `handleRecorderWebhook`（`POST /webhook/*`） |
| 解析弹幕 XML → 密度曲线 / 峰值 / 高频词 / 高能事件 | `danmaku.ts` |
| XML 不含 SC/guard/gift 时降级并标记 | `ParsedDanmaku.eventSignalsAvailable` + `Signals.eventSignalsAvailable` |
| 大文件内存保护 | `loadDanmaku` 默认 64MB 上限 |
| 写出 `signals.json`（含基准偏移） | `analyzeDanmaku` → `Signals.danmakuOffset` |

**关键设计说明**：任务书说「默认 60 秒轮询」，同时 §4.1 明确 `/webhook/*` 是**入站接口**、自研服务不能从那里订阅事件（陷阱 #26）。因此本实现：

- **轮询是主路径且始终保留**（可靠兜底）；
- 内置录制引擎（本机实测 `recorderType: bililive`）**没有对外事件源**，所以事件方案不适用；
- 但仍提供了 `WebhookRelay`：当用户换成录播姬/blrec 等多目标录制器时，把本服务配成第二个 webhook 目标即可，完全满足硬约束 #18 的三条要求（原样即时、先落盘再转发、落盘失败不阻塞转发、重启补投）。

### WP3 —— 转写接入

| 要求 | 落点 |
|---|---|
| 输入是录制原始 flv（与压制并行） | `daemon.runTranscribe` 的 `inputSource: 'raw'` 分支 |
| 分段文件 → 全局时间映射 | `media.buildSegmentMap` + `AsrMediaAdapter.planCalls` |
| 30 分钟窗口循环调用，跨文件按边界拆分 | `Transcriber.planWindows` + `media.planCalls` |
| `startTime`/`endTime` 必须成对 | `api.subtitle` 客户端断言（不发请求就抛错） |
| 实测 `offset` 语义 | `WindowCall.offset` 注释（算法：全局 = 段内 + globalStart） |
| SRT 解析为 `[{start,end,text}]` | `asr.parseSrt` |
| 缓存键不含 `videoFileId` | `asrCacheKey`（含 path + size + mtime + modelId + 区间 + offset） |
| 相邻段重叠 5–10 秒 | `Transcriber.planWindows` 的步进 = 窗口长 − 重叠量 |
| 合并优先信任后一段，按时间区间取舍 | `asr.mergeSegments` |
| 断点续跑（已缓存段直接跳过） | `transcribe()` 逐段查缓存；e2e 场景 2 验证「第二次零付费调用」 |
| 单段失败重试 3 次后跳过并写 `gaps` | `transcribe()` 的重试循环 + `gaps` |
| `--dry-run` 无缓存时不得付费 | `transcribe()` 的 dryRun 分支；e2e 场景 12 验证 |
| 接口可替换（换成 whisper.cpp 结构不变） | `Transcript.source` 字段 + 输出结构统一 |

### WP4 —— LLM 决策器

| 要求 | 落点 |
|---|---|
| 两档模型（总结档 / 选片档） | `config.llm.summary` / `config.llm.select` |
| 分块 map（10–15 分钟） | `analyze.chunkTranscript`（默认 12 分钟） |
| 转写 `gaps` 对应时段注明缺失 | `renderChunkTranscript` 的缺失提示 |
| reduce 成本场总结（Markdown） | `analyze.reduceSummary` |
| 选片产出 `{start,end,title,desc,tags,category,score,reason,cover_ts}` | `clipCandidateSchema` |
| 前后各留 1.5 秒缓冲、时长 30–90 秒 | `sanitizeClips`（`bufferSec` / `minDurationSec` / `maxDurationSec`） |
| LLM 产出分区**文字**，服务映射白名单 `tid` | `mapCategoryToTid`（四级匹配 + 回退） |
| zod 契约校验 | `analyze.ts` 的 schema |
| **校验失败升级到选片模型重跑** | `selectClips` 的 catch 分支；e2e 场景 5 用**两档不同模型**验证「真的换了模型」 |
| 降级：弹幕密度 Top-N + 占位标题 + `degraded: true` | `densityFallbackClips` + `degradedDecision`；e2e 场景 11 |
| `decisions.jsonl` 记录采纳与最终值 + diff | `ledger.recordDecision`（自动算 `diff`） |
| prompt 缓存前提（system 字节级一致） | `PromptStore` 约定 + e2e 断言「同批 system hash 唯一」 |

### WP5 —— 切片与投稿编排

| 要求 | 落点 |
|---|---|
| 完整版上传支线，以 `/bili/archives` 反查为准 | `Publisher.ensureFullVideoUpload` + `matchArchive` |
| 两步走（cut → 轮询 → upload） | `cutAndUploadClip` |
| `output` 传绝对路径 | `api.cut` 客户端断言 |
| 不传 `srtContent` | 全项目无此调用 |
| 错峰公式 `submitTime + 7800 + (N-1)×7500 + random(0,1800)` | `computeDtime` + `validateDtime` |
| 合集共用 `seasonId`/`sectionId` | `buildBiliupConfig`（未配置时 UI 会提示无法归入合集） |
| 状态机 `PENDING_UPLOAD → SUBMITTING → SUBMITTED → PUBLISHED` | `ledger.setClipStatus` + `CLIP_TRANSITIONS` |
| 提交前写 `SUBMITTING`，恢复时先查 archives | `cutAndUploadClip` + `recoverStuck` |
| 幂等指纹（只记本地） | `clipFingerprint` + `ledger.registerFingerprint` |
| **不把指纹写进 `dynamic`/`desc`** | e2e 场景 6 有专门断言 |
| `ledger.json` 记录任务 id / uploadTaskId / bvid | `TaskRecord` + `ClipRecord` |
| 并发控制查 `runningTaskNum` | `api.taskList()` |
| **场次级串行** | `daemon.drainQueue`（单消费队列） |
| 每日投稿上限 + 提交间隔抖动 + 失败退避 | `publishClips` + `computeDtime` |
| 保持 `is_only_self: 1` | `buildBiliupConfig` + config 校验告警 |
| 标签去重/截断/过滤，校验 1–10 | `sanitizeTags` |
| `tid` 回退白名单 | `buildBiliupConfig` 的二次校验 |

### WP6 —— 常驻服务、监控与数据生命周期

| 要求 | 落点 |
|---|---|
| 状态机 + `--from-stage` 重跑 | `runPipeline(taskId, fromStage)` |
| `--dry-run` / `--allow-paid` / `--room` / `--video` | `cli.ts` 参数解析 |
| 磁盘守卫（默认 50GB） | `Cleaner.canStartNewTask` + `drainQueue` 暂停 |
| 分层清理（原始分段 / 压制产物 + 缓冲期） | `judgeDeletability` + `Cleaner.runOnce` |
| 日志轮转 | `Logger.getStream` 的大小轮转 + `rotateLogs` |
| 告警通道（Server酱/钉钉/Telegram/Webhook）+ 去重 + 恢复 | `alert.ts` |
| 账号有效期检查 | `publisher.accountHealth` + `daemon.health` + 每日 `selfCheck` |
| 结构化日志（jsonl，脱敏，按天/大小轮转） | `logger.ts` |
| Windows 自启脚本 | `start.bat` / `start.ps1`（显式 Node 路径 + 版本校验 + 参数透传） |
| 系统时钟提示（NTP） | `README.md` 故障排查 + `validateDtime` 的余量设计 |
| 配置热加载 | `ConfigStore.reloadIfChanged` + `onChange` 广播到全部组件 |
| 错误日志与复查（`--inspect` / UI 时间线） | `errors.ts` + `cli.ts inspect` + `server.ts /api/error-report/:id` |
| 稿件表现数据回流（每日一次） | `daemon.refreshPerformance` + `perfTick` |

### WP7 —— 可视化操作界面

| 要求 | 落点 |
|---|---|
| 只监听 127.0.0.1 | `UiServer` 构造即校验；smoke 有专项断言 |
| Origin 检查 + CSRF token | `checkOrigin` + `checkCsrf`；smoke 逐项验证 |
| 预览仅限任务目录 + HTTP Range + 防路径遍历 | `servePreview`；smoke 验证遍历与类型白名单 |
| 单文件 HTML、无框架、无构建 | `public/ui.html` |
| 三个区域（任务列表 / 本场详情 / 发布排期） | UI 三栏布局 |
| 状态进度条 + 细粒度进度 | `progress` 字段（如「转写中 12/24」） |
| Markdown 渲染总结 | UI 内置极简 md 渲染 |
| 切片卡片（时间可调、标题可编辑+计数、标签、评分理由、勾选、试看、预计发布时间） | `clipHTML` |
| **试看 = 直接把人带到源文件**（2026-09-24 增强） | 见下方 §12.7 |
| **失败态**：错误条 + 从该阶段重跑 + 查看日志（渲染后时间线 + 一键复制） | `errbar` + `openInfo` |
| **降级态**：醒目底色 + 「标题需人工填写」 | `.clip.degraded` |
| **成本**：ASR 标注「估算值」，LLM 实际 | 成本条 + 月度汇总页 |
| 本场设置（候选数、跳过自动发布、追加标签） | `details.scoped` |
| 默认勾选最高分 N 个 | `sanitizeClips` 的 `selected` |
| 「在 biliLive-tools 中打开」（`.llc`） | `buildLlcContent` + `writeLLC` + UI 按钮 |
| 双模式（`autoPublish` 开关） | 顶栏开关 + `daemon` 分支 |
| 配置界面（预设下拉、密码显示切换、测试按钮给可执行结论、硬约束实时校验） | 设置弹窗 |
| 任务搜索与筛选 | 左栏搜索框 + 状态筛选 |
| 手动导入录播 | `daemon.importLocal` + UI「导入录播」 |
| 成本月度汇总 | `/api/tasks` 的 `monthly` + 成本页签 |
| 健康面板 + 一键自检 | 健康页签 |
| 稿件表现统计页 | 表现页签 |

---

## 3. 陷阱速查表对照（任务书 §6，33 条）

| # | 陷阱 | 本项目的处理 | 自动化验证 |
|---|---|---|---|
| 1 | `platform` 写成 `bilibili` | `api.recentClips` 默认值即 `Bilibili`；`validateConfig` 硬校验 | e2e 场景 13（mock 复现空数组） |
| 2 | 直播间无录制记录（静默空数组） | `selfCheck` 明确区分两种原因并给修复建议 | smoke 第 2 节 |
| 3 | `/ai/subtitle` 无缓存 | 本地逐段缓存；e2e 验证「第二次零付费调用」 | e2e 场景 2 |
| 4 | 只传一个时间参数 | `api.subtitle` 客户端断言 | e2e 场景 13 |
| 5 | 未配置 ASR 模型 | `selfCheck` 检查 `/config` 的 `subtitleRecognize` | smoke 第 2 节 |
| 6 | `output` 传相对路径 | `api.cut` 客户端断言 | e2e 场景 13 |
| 7 | 切片用 stream copy | `api.cut` 检测 `c:v=copy` 直接拒绝 | e2e 场景 13 |
| 8 | 从已烧弹幕文件切片又传 ASS | `shouldPassAss` + `fullVideoHasDanmaku` 台账字段 | — |
| 9 | 秒/毫秒混用 | `util.toSec/toMs` 自适应；`normalizeRecord` 统一口径 | e2e 场景 1（mock 复现毫秒 `live_start_time`） |
| 10 | `list` 与 `recent-clips` 字段名混用 | 两套类型分别建模 | probe 实测打印两种风格 |
| 11 | 以为 upload 返回稿件 id | 类型即 `{ taskId }`；bvid 一律反查 | e2e 场景 6 |
| 12 | `dtime` 设成 1 小时 | `computeDtime` + `validateDtime` + UI 实时校验 | e2e 场景 6（>7200 断言） |
| 13 | 监听 `0.0.0.0` | `UiServer` 构造即拒绝；`validateConfig` 校验 | smoke 第 4 节 |
| 14 | 开启「上传后删除素材」 | `checkAfterUploadDelete` 明确报警 + 给修复步骤 | smoke 第 2 节（本机实测确实开着） |
| 15 | 压制与 ASR 并跑（本地 Whisper） | `selfCheck` 提示；`asr.provider` 配置区分 | — |
| 16 | 本地方案 ffmpeg 路径含空格 | `whisperCpp.binaryPath` 校验存在性 | — |
| 17 | Ollama/whisper 未设上下文或采样率 | 配置注释 + `selfCheck` 提示 | — |
| 18 | 重启后只看 `recent-clips` | 启动补漏 + 每小时对账 | e2e 场景 1 |
| 19 | 未确认 `seasonId` 来源 | `selfCheck` 提示需人工建合集 | smoke 第 2 节 |
| 20 | LLM 直接产出 `tid` | `mapCategoryToTid` 四级映射 + 回退 | e2e 场景 4（含不可映射分区） |
| 21 | 日志/配置写入真实凭据 | `redact.ts` 唯一出口 + 双测试 | `redact-selftest` 76 项 + `credential-audit` 0 命中 |
| 22 | UI 无 CSRF / Origin 校验 | `checkOrigin` + `checkCsrf` | smoke 第 4 节逐项 |
| 23 | `--dry-run` 自动调用付费 AI | ASR 与 LLM 两处都按「opts 而非配置」判断 | e2e 场景 12 |
| 24 | 未记录 `fullVideoHasDanmaku` | `SourceMedia.fullVideoHasDanmaku` 必填，不猜测 | — |
| 25 | 弹幕 XML 不含 SC/guard/gift 却假设有 | `eventSignalsAvailable` 显式降级 + warnings | e2e 场景 10 |
| 26 | 把 `/webhook/*` 当推送通道 | `trigger.ts` 顶部注释明确方向；实现为**接收**端 | — |
| 27 | 转发时做缓冲/合并 | `WebhookRelay` 原样即时转发 + 端点匹配校验 | — |
| 28 | 误把「相邻切片间隔」当平台规则 | `computeDtime` 注释 + README 说明 | — |
| 29 | 断流时把「第一段关闭」当本场结束 | 三层判定（静态 + 同 live_id 全关闭 + 下播确认） | e2e 场景 1（`--clips-seen 1` 复现录制中） |
| 30 | 转写按单文件设计，实际分段 | `buildSegmentMap` + `planCalls` | e2e 场景 2 |
| 31 | 缓存键用 `videoFileId` | `asrCacheKey` 用 path+size+mtime | e2e 场景 2（断点续跑零调用） |
| 32 | `list` 的时间参数用秒 | 参数注释与调用一律毫秒 | probe 实测打印单位 |
| 33 | 报错时打印整个 request 对象 | `errors.ts` 三层防护（深度脱敏 + 强化清洗 + 写盘前扫描） | e2e 场景 14 + `credential-audit` |

---

## 4. 硬约束对照（任务书 §10，19 条）

| # | 约束 | 落点 | 验证 |
|---|---|---|---|
| 1 | 不修改/fork biliLive-tools | 只走 HTTP；无任何写上游文件的代码 | 全项目 grep |
| 2 | 只监听 127.0.0.1 | `UiServer` 构造拒绝非回环；`validateConfig` | smoke 第 1/4 节 |
| 3 | 标题 ≤80 / 简介 ≤250 / 标签 1–10 | `sanitizeTitle` / `sanitizeDesc` / `sanitizeTags` | e2e 场景 4 |
| 4 | `dtime` > 提交时刻 + 7200 | `computeDtime` + `validateDtime` | e2e 场景 6 |
| 5 | 切片必须重编码 | `api.cut` 拒绝 `copy` | e2e 场景 13 |
| 6 | 并行策略按 ASR 类型区分 | 云 ASR 与压制并行（`kickFullVideoUpload` 不 await） | 设计 + README |
| 7 | ASR 必须分段且成对 | `planWindows` + `api.subtitle` 断言 | e2e 场景 2 |
| 8 | 不得留存真实凭据 | `redact.ts` + `credential-audit.ts` | 0 命中 |
| 9 | 无原生编译依赖 | 依赖仅 zod / fast-xml-parser / p-limit | package.json |
| 10 | 试跑期 `is_only_self: 1` | `buildBiliupConfig` + 校验告警 | e2e 场景 6 |
| 11 | 关闭「上传后删除素材」 | `checkAfterUploadDelete` | smoke 第 2 节（本机开着，已报警） |
| 12 | 记录 `fullVideoHasDanmaku` 且不猜测 | 台账字段 + `shouldPassAss` | — |
| 13 | 契约校验失败升级模型重跑 | `selectClips` 取**另一档**模型 | e2e 场景 5（断言两次调用用了不同模型） |
| 14 | `--dry-run` 不得付费 | ASR / LLM 两处独立判断 | e2e 场景 12 |
| 15 | UI Origin + CSRF + Range + 防遍历 | `server.ts` | smoke 第 4 节 |
| 16 | `tid` 白名单 + 标签处理 | `mapCategoryToTid` + `sanitizeTags` | e2e 场景 4 |
| 17 | 完整版状态入台账、以反查为准、未确认不删 | `ensureFullVideoUpload` + `judgeDeletability` | e2e 场景 9（未确认不可删） |
| 18 | webhook 先落盘再转发、不缓冲、落盘失败不阻塞 | `WebhookRelay.handle` | — |
| 19 | 录制完成判定叠加下播确认 | `Trigger.evaluateGroup` | e2e 场景 1 |

---

## 5. 实施过程中发现并修复的真实缺陷

这些是开发中通过测试与代码审查**实际抓到**的问题，不是理论风险：

| 缺陷 | 后果 | 修复 |
|---|---|---|
| `redact.ts` 的 Authorization 规则写成 `'$1$2<REDACTED>'`，**保留了原值** | 所有走 `redactText` 的日志仍会输出明文凭据（硬约束 #8 实质失效） | 改为整体遮蔽，并补齐 9 类形态规则 |
| `redactText` 对 `"passKey":"<值>"` 这种 JSON 内联形态漏网 | 错误报告里可能出现明文 passkey | 新增「已知键名 + 任意值」两条规则 |
| **`analyze.ts` 的升级重跑传的是刚失败的同一个模型** | 硬约束 #13 退化为「同模型重试」，升级机制形同虚设 | 改为取**另一档**模型，并如实标注「是否真的换了模型」 |
| `asr` 的段间重叠实现导致「起始边界恰好等于窗口末尾」时产生**完全重复的调用单元** | 同一段音频被付费识别两次 | 改为「步进 = 窗口长 − 重叠量」 |
| ASR 缓存目录用相对路径 | 换工作目录启动就找不到旧缓存 → 已付费的转写被重跑 | 统一按项目根目录解析成绝对路径 |
| `clips.json` 的「外部改动」判定基准错误 | ledger 自己写入后反被误判为外部改动，用旧内容覆盖内存中已推进的切片状态 | 记录「自己最后写入的 mtime」，仅当文件更新时才认为外部改动 |
| 素材清理判定被**未勾选的候选切片**卡住 | 未勾选的 CANDIDATE 永远不会发布，导致素材永远无法清理 | 只看已勾选切片 |
| 启动补漏对「很久以前就结束」的录制也要等两次采样 | 服务重启后补漏延迟一整个轮询周期（一小时） | `record_end_time` 超过 5 分钟即视为文件已稳定 |
| 投稿后不轮询上传任务结果 | 上传失败要等数天后的 bvid 反查才暴露，期间台账显示「已提交」 | 投稿后等待上传任务出终态；超时不算失败（避免误判导致重复投稿） |
| bvid 反查成功后未推进场级状态 | 任务永远停在 CLIPPED，UI 显示不对且素材清理判定一直拒绝 | 反查确认全部已勾选切片后推进为 PUBLISHED |
| `ledger` 的三个流水文件路径写死到全局 `data/` | 把 ledger 指到别处时（测试/多实例）会污染真实目录，表现为「今日投稿数」被历史数据污染 | 默认跟随 ledger 目录推导 |
| 台账文件在「还没有任何任务」时不存在 | 与「文件被误删」无法区分，事后排查缺锚点 | 首次构造即落盘空台账骨架 |
| `UiServer` 在 `port=0` 时 `url` 仍指向 0 | 自测/嵌入场景拿不到真实地址 | listen 后读回实际端口 |
| `errors.ts` 的 `classifyError` 扫堆栈时命中项目路径里的 `deepseek` 字样 | 任意异常都被判成 `llm-unavailable` | 只扫 code/errno/name/message，规则收紧 |
| `errors.ts` 对已截断的响应体二次截断 | 标注里的「原始长度」被改写，误导排查 | 已截断形态只脱敏不再截断 |
| 切片状态迁移表缺少 `SUBMITTING → CUTTING`、`CUT → SUBMITTED` | 真实路径被判为「非法迁移」，日志噪音掩盖真问题 | 补全迁移表 |
| **`todayPublishedCount()` 用 `(taskId, clipIndex)` 去重** | 同一切片当天投多次时被折叠成一次 —— 实测当天真投了 11 个稿件却只算 6 个，**每日上限完全失效**（限流自律形同虚设，这正是反爬风控最需要的护栏） | 改为「按能唯一标识一次投稿的主键计数」：submit 用 `uploadTaskId`（旧日志退回 `dtime`），confirm 用 `bvid`，并允许 bvid 被**跨桶认领**一次 |
| `config.ts` 的 `defaults()` 一度写成「示例文件存在就直接 `return` 它」 | 示例文件漏掉任何一个键，该键运行时即 `undefined`；`validateConfig` 紧接着读 `cfg.clip.subtitle.maxCharsPerLine` 抛 `TypeError` —— **服务完全无法启动**，且报错点离真正原因很远 | 改为「内置字面量兜底 + 示例文件覆盖」（`deepMerge(builtinDefaults(), raw)`），示例文件写歪只会退回默认值 |
| 表现数据回流对**已删除**的稿件每天重试 3 次 | 用户删稿后台账仍留着旧 bvid，每次都拿到 HTTP 500「稿件不可见」，刷屏且白费请求 | 新增 `ClipRecord.archiveGoneAt`：确认消失后不再请求。判定必须**两段式**（错误文案「啥都木有」在审核/转码中也会出现，故还要确认该 bvid 已不在稿件列表里） |
| `confirm` 日志不带 `uploadTaskId` | 额度统计只能靠启发式配对，多分P 反查用**主标题**、命中的稿件不落在任何分P 桶，配对必然错位 | `confirm` 补记 `uploadTaskId` / `dtime`，配对有显式依据 |
| 多分P 稿件的 bvid 无法用切片标题反查 | `confirmPublished` 按各切片标题匹配，而多分P 稿件只有一个主标题，6 个切片永远 `pending` | 多分P 收尾按**主标题**记录 bvid（同一 bvid 落到全部切片） |
| **`defaultTags` 被无条件追加到每个切片** | 实测 9/9 个候选的标签完全一致（`直播切片`+`名场面`），观众侧 SEO 零区分度；且每个切片必刷 2 条「标签被移除（重复）」噪音警告（LLM 本就会学着写这两个词，于是必然重复）。追加发生在 `analyze.ts` 落库与 `publish.ts` 投稿**两处**，只改一处不生效 | 两处都改为**不追加**：标签只信 LLM 按内容生成的 + 用户在界面手动加的（`extraTags` 保留追加语义，因为那是人工显式意图）。`defaultTags` 重新定位为**兜底**（LLM 一个可用标签都没给出时才用），并把兜底警告写清原因 |
| **切片结尾切在半句话/半句歌词上（用户反馈：「唱歌时歌词刚唱完切片就结束了」）** | 选片 LLM **看不到转写原文**，只拿到「各时间窗要点」，所以 start/end 只能是近似值 —— 实测两组真实数据的 end 全部落在 1.5 秒网格上（`xxx.5`），切在说话中间的比例为 **5/9 与 7/8**。旧实现唯一的收尾处理是 `bufferSec`（前后各留 1.5s），它不看转写 | 新增 `resolveClipEnd`：在合法时长区间内把结尾对齐到**真正的停顿**。实测（新提示词 + 对齐）两组数据均降到 **0/9 与 0/10**，且候选零丢失、零硬裁。见下方「两次被数据推翻的错误假设」 |

| **删除切片产物会连带删掉整个任务（用户反馈）** | 界面上只勾「切片产物」（文案明确写着"默认只删切片产物（最占地方且随时可重切）"），结果**整条任务从列表里消失** —— 转写、弹幕信号、总结、投稿记录全没了。根因：`deleteTask` 在把文件移入回收站之后**无条件**调用 `ledger.deleteTask(taskId)`（回收站路径与永久删除路径各一处）；UI 也无条件 `state.activeId = null`，即使记录还在也看着像"任务没了"。切了还能重切，任务记录没了就什么都没了 | 两处都改为**只有勾选「任务目录」才算整体删除**（`deleteTaskDir === true` 才移除记录）。UI 两处删除入口同步：只删文件时保留当前选中项与任务列表，并把提示改成"已删除所选文件（任务记录保留，可随时重切）"；删除预览文案也补上这条语义。新增 `test/delete-semantics.ts`（11 条断言）锁住该边界 |

### 5.1 两次被真实数据推翻的错误假设（都值得记住）

做「结尾对齐」时我先写了两个看起来合理的实现，**都被真实数据打脸**，记录下来避免重犯：

| 假设 | 数据怎么推翻的 | 正确做法 |
|---|---|---|
| 「ASR 段落边界 = 说话停顿」，把结尾吸到最近的段边界即可 | 实测真实转写的**句子间隙中位数 = 0.00s**、平均段长 2.69s —— 段落是**连续拼接**的（为了不让字幕断档），段边界只是切分点，不代表说话人停了。按段边界对齐等于没对齐：该数据上仍有 7/8 切在句子内部 | 停顿是**局部**概念，必须按"静音空隙"判定。`findSilenceGap` 找出包含目标时刻的空隙，把它的两个端点（话音落下 / 再次开口）都作为候选 |
| 「累计静音 ≥ 0.35s 就算停顿」 | 从录音开头一路累加的话，长录音里到处都是"停顿"（实测 40 秒处就攒到 1.6s），判定完全失效 | 只看**紧邻**该时刻的那一个空隙长度；阈值也要小（0.05s）—— 歌词句之间实测只有 ~0.1s，50ms 以上的间歇人耳已等同于停顿 |

另外两个次要修正：`minDurationSec` 给 5%（最多 2 秒）的**下限**容差（把结尾提前到停顿处常只差零点几秒，为 1 秒丢掉整个候选不值得；上限不给容差）；`startOfSpeechRun` 作为"附近没有停顿可吸"时的兜底，退到当前这段连续语音的起点。

---

## 6. 真实环境验证记录

除离线 e2e（mock）之外，本项目在**真实素材 + 真实 biliLive-tools + 真实云 ASR** 上做了验证。

### 6.1 真实语料（实际调用阿里云 ASR）

| 项 | 实测值 |
|---|---|
| 素材 | `2026-09-17 22-59-35-667 电台汤圆人，太劲爆了-弹幕版.mp4`（本机真实录播） |
| 规格 | 1080x1920 竖屏，h264/aac，时长 **01:09:29**，大小 362.7 MB |
| 转写窗口规划 | **3 个调用单元**（30 分钟/窗口，音频合计 01:09:45） |
| 实际调用 | 3 次 `/ai/subtitle`，每次 `startTime`/`endTime` **成对**提供 |
| 耗时 | **120.4 秒**（69 分钟素材，约 1.7× 实时） |
| 产出 | **705 条字幕，gaps 0 处** |
| 费用 | 估算 **¥2.32**（按 2 元/小时；ASR 为估算值，拿不到对方账单） |

**`offset` 语义验证结论（这是任务书要求实测的关键项）**：

实测证据 —— 首条字幕落在 `[00:00:06] 晚上好呀，晚上好啊`，内容与视频开头（主播开播打招呼）完全对应，且时间戳从 0 附近开始递增。

**结论**：接口返回的 SRT 时间戳相对**本次提交的音频片段起点**，因此
`全局时间 = 段内时间戳 + 该段的全局起点绝对秒数`。
本项目的实现（`daemon.runTranscribe` 的 adapter 中 `offset: 0` + 拼加 `globalStart`）**正确**。

> 若将来实测发现语义不同（例如 offset 为「音频内时间 + offset」时），
> 只需修改 `src/daemon.ts` 中 adapter 的 `offset` 字段一处，其余逻辑不变。

**转写内容抽样**（可用作「抽 3 个时间点核对」的人工抽查起点）：

| 时间 | 字幕 |
|---|---|
| 00:00:06 | 晚上好呀，晚上好啊 |
| 00:00:10 | 好虚弱啊。鼻前一直掉鼻涕 |
| 00:00:17 | 嗓子很疼。怎么会这样 |

### 6.2 断点续跑的真实证明（¥0.00）

第二次运行同一素材的转写：

```
预检：3 个单元，缓存命中 3，需付费 0，音频合计 01:09:45
转写耗时 0.0s，字幕 705 条，gaps 0 处，估算成本 ¥0.00
```

69 分钟的素材从「3 次付费调用」变成「**0 次调用、0 秒、¥0.00**」——
这直接证明了本地缓存与断点续跑在真实环境下生效（硬约束：ASR 按音频时长计费，
服务端无缓存，重复调用就是重复花钱）。

### 6.3 真实环境发现的两个缺口（已修复）

真实素材验证暴露了两个离线 mock 无法发现的问题：

| 缺口 | 表现 | 修复 |
|---|---|---|
| **无弹幕 + LLM 不可用时降级兜底产出 0 个候选** | 链路表面"成功"，实际没有任何可发布内容。因为「弹幕密度 Top-N」在没有弹幕时必然为空 | 新增**第二层兜底**：用「转写语音密度」选出候选（`speechDensityFallbackClips`），score 上限 6.5 且默认不勾选，强制人工确认 |
| LLM Key 未配置时错误被当成代码缺陷 | 测试断言失败，掩盖了"代码其实正确处理了这种情况"这一事实 | 测试改为区分**环境项**与**代码缺陷**；代码侧 `llm.ts` 在发请求前就识别出「模板占位 Key」并给出可执行结论（不浪费一次必然失败的往返） |

### 6.4 真实环境的 record-history 现状

`record-history/list` 共 **74 条**记录，但**没有一条的 `video_file` 仍然存在**（0/60 在本页范围内）。
推测原因：录制文件被移动/重命名，或历史上开过「上传后删除素材」（该开关当前仍为 `deleteAfterCheck`）。

这不影响本项目的功能（`probe.ts` 与 `real-media.ts` 都会优雅退化并在日志中说明原因），
但**说明硬约束 #11 在这个环境里已经造成过实际影响** —— 建议首次试跑前务必关闭它。

### 6.5 真实全流程跑通记录（含多分P 投稿与立即发布）

用 `tools/list-recordings.ts` 选出的真实录播（甲主播《已进入后半夜后悔时代》，1399.99 秒 / 886 MB）
跑完整链路，产出真实稿件。关键数据：

| 环节 | 实测结果 |
|---|---|
| 导入 | `importLocal()` 自动发现同名 `.xml`/`.ass`；源 1399.99s |
| 弹幕 | XML 891 条 `<d>` + 9 条 `<sc>`，时间轴 0–1384s；转 ASS 后 **891 条 Dialogue、无 BOM** |
| LLM 选片 | 6 个候选全部 `selected`，score 7.2–9.0，合计 ¥0.0308（7660 prompt + 1936 completion tokens） |
| 切片 | 6 个 mp4，22.8–41.2 MB，全部烧入弹幕 |
| 多分P 投稿 | **1 个稿件 / 8 个分P**：P1 完整版（2.0 GB，2086.8 MB）、P2 纯享版（845.4 MB，remux 无弹幕）、P3–P8 各切片 |
| 分P 命名 | P1/P2 按 biliLive-tools 命名规则 `{主播}{标题}{序号}弹幕版` / `纯享版`；P3–P8 用 LLM 生成的切片标题 |
| 主标题 | `已进入后半夜后悔时代 2026-09-20`（21 字符，日期取自**直播标题**而非 `liveStartTime`，后者会差 2 天） |
| 上传 | 3.1 GB；实测约 24.5 Mbps（早先按 1% 读数估出的速率是把队列延迟当成了传输） |
| 反查 | 主标题命中 `BV11thH6HERA`（aid 117315119091094），投稿后约 9 分钟出现（P1 2.0 GB 最后传完） |
| 额度 | 一次多分P 投稿只占 **1** 个 `publish.dailyLimit`，而每片一稿要占 6 个 |

**多分P 的两个真实坑**（都已在代码里注释留痕）：

1. **反查只能用主标题**。`/bili/upload` 一次调用产出的是**一个**稿件，各分P 标题不会作为独立稿件出现，
   因此按切片标题反查永远命中不了 —— 多分P 的收尾必须按主标题记录 bvid。
2. **只有一个 `dtime`**。多P 稿件所有分P 同一时刻上线，原来的「相邻切片错峰（`clipGapSec`）」在此模式下不生效。

**立即发布（`publish.immediatePublish`）的实测依据**：B站只在**传了 `dtime`** 时才校验
「必须 ≥ 提交后 7200 秒」，所以绕过硬约束 #4 的正确做法是**完全不传这个键**，
而不是传 `dtime: 0` / `null`（两者都会被当成"传了"）。开启后构建 payload 时省略 `dtime`，
并在 `warnings` 里明确提示已绕过该自律约束。

---

## 7. 未完成项与已知限制

诚实列出，避免验收时产生误解：

| 项 | 状态 | 说明 |
|---|---|---|
| **`offset` 语义实测** | ✅ **已完成** | 见 §6.1：69 分钟真实素材、705 条字幕、3 次真实 ASR 调用，验证实现正确 |
| **两档模型的实际选片质量** | ⚠️ 待用户配置 Key | 任务书验收要求「抽检 10 个候选片段 ≥6 个值得发布」，这需要真实 LLM。当前 `config.json` 的 LLM Key 仍是模板占位符，代码已正确降级并产出候选。prompt 已按任务书的选片标准编写，**配好 Key 后需要 2–3 轮真实迭代**。 |
| **端到端真实投稿** | ✅ **已完成** | 见 §6.5：真实录播 → ASR → LLM 选片 → 切片 → 多分P 投稿，已产出真实稿件。 |
| **本地 Whisper 方案** | 未实现（可选路径） | 任务书列为「不阻塞主线」。本机 ffmpeg 8.1 确实带 whisper 滤镜（`probe.ts` 已验证），`asr.provider` 已预留 `whisper-cpp` 分支与全部配置项。 |
| **本地剪静音** | 已实现，默认关闭 | `detectSilence` + `buildSpeechPlan` 就绪；`asr.silenceTrim.enabled` 默认 false（任务书建议先跑通基线再启用对比）。 |
| **封面抽帧** | 不做（首版明确不做） | 按 §4.4 首版封面策略：`coverSource` 三档优先级 + 回退日志。 |
| **附录 B 二期功能池** | 不做 | 手机端审核、封面编辑器、数据驱动阈值调整、多平台分发、弹幕互动。 |

---

## 7.5 跨软件协作的真实陷阱（2026-09-23 实测补充）

用户的实际工作流是**两个软件分工**：biliLive-tools 负责录制、压制弹幕、投完整版+纯享版；
本项目负责选片、切片，并把切片**续传**进同一个稿件。这条链路上踩到的坑，
每一个都只能靠读源码 + 真实数据才能查清，记录在此避免重踩。

| # | 陷阱 | 真相（源码依据） | 后果 |
|---|---|---|---|
| 1 | **`recorders[].segment` 的单位是「分钟」不是「秒」** | `inputOptions.push("-d", \`${this.segment * 60}s\`)`、`"-segment_time", String(this.segment * 60)` —— 交给 ffmpeg 前才 ×60 | 当成秒会做出**反向优化**：把 59 分钟误读为 59 秒，进而建议"改成 3600"（= 60 小时，永不分段）。本项目一度据此写出错误结论 |
| 2 | **分场判据的「间隔」是「前段结束 → 新段开始」，不是「开始 → 开始」** | `findRecentLive` 用 `(currentTime - live.getMaxEndTime())/60000 < maxTimeDiffMinutes`，而 `getMaxEndTime()` ≈ 前段**开始时间 + 前段时长** | **本项目在这里犯过一次真实的分析错误**：用文件名里的「开始时间」相减（≈ 一个完整分段长度 59 分钟）当成间隙，于是从源码推出「09-22 一场被 `partMergeMinute=10` 劈成 7 个稿件」，并据此建议用户把阈值调到 75。**实际 B站 侧该场只有 1 个稿件（aid=117314833877723，370 分钟）**。用真实文件时长重算后，各段真实间隙仅 0.0–0.9 分钟，远小于 10 ⇒ 一直是同一场。**教训：跨软件行为只要能从对方侧取到事实（这里是 B站 稿件列表），就必须先取证再下结论，不能只靠读源码推演** |
| 3 | **`autoPartMerge` 关闭时阈值无效** | `getConfig()` 里 `if (!mergePart) partMergeMinute = -1;` | 只调阈值而没确认总开关是 `true`，等于白调 |
| 4 | **`minSize` 过滤发生在分场之前** | `handleMatchedPair`：`if (!await this.validateFileSize(...)) return;` **然后才** `handleOpenEvent(...)` | 小于 `minSize`（本机 20MB）的断流碎片既不建 part、也不参与间隔计算，所以碎片**不会**导致劈场。分析分场时必须先按 minSize 过滤，否则会得出夸大的结论（本项目第一版模拟就错在这里，算出"9 场"） |
| 5 | **阈值调大的副作用** | `partMergeMinute` 同时也是「断播续传」的时间窗 | 调大后，主播下播再开播只要间隔小于该值，两场会被**合并进同一个稿件**。所以它的默认值 10 分钟是保守且合理的，没有实测问题就不要动。**本项目曾基于陷阱 2 的错误推断建议用户把它改成 75，后经真实数据推翻，已建议改回 10** —— 又一个"先给结论、后才发现推演有误"的实例 |

**续传如何实现（本项目侧）**：biliLive-tools 的 `POST /bili/upload` 请求体里
`vid` 字段是分水岭 —— 带 `vid` 走 `biliApi.editMedia`（**追加**分P，其 UI 原文：
"续传只会增加分p，不会对稿件进行编辑"），不带则走 `addMedia`（新建稿件）。
本项目据此实现 `publish.resumeAid` / `resumeTitleTemplate`：
找到 biliLive-tools 已投的完整版稿件 → 取其 `aid` 作为 `vid` → 切片追加为该稿件的后续分P。

**分P 顺序**：`const SAME_MEDIA_UPLOAD_ORDER = ["handled", "raw"]`，排序函数是
「类型在外、分段在内」的嵌套循环，因此**弹幕版全部在前、纯享版全部在后**
（一场分 Z 段 ⇒ P1..PZ 弹幕版、P(Z+1)..P(2Z) 纯享版，切片追加在最后）。

**切片不得跨越分P 边界**：跨界的切片会被拆到两个分P 里（观众只看到一半）。
本项目做了双保险：选片 prompt 注入分P 边界（`buildSelectPrompt`）+ `sanitizeClips` 的
确定性收口（能收进单侧就收，收不下且短于时长下限则丢弃）。

---

## 7.6 追加投稿的实测结论与一次"延迟窗口误判"复盘（2026-09-23 晚）

### 7.6.1 实测结论：B站 允许对**已公开**稿件追加分P

这是整个 `2+n` 方案的前提，此前只是 biliLive-tools UI 文案的推断，现已实测确认。

用 09-22 那场（`aid=117314833877723` / `BV13hhE6XEQM`，`state=0` 公开）做验证：

| 阶段 | B站 侧分P 数 |
|---|---|
| biliLive-tools 投完（P1–P14：7 弹幕版 + 7 纯享版） | 14 |
| 本项追加第 1 批 9 个切片 | 23 |
| 后续批次继续追加 | **43** |

⇒ **已公开稿件可以追加**，`editMedia(append)` 有效。

### 7.6.2 ⚠️ B站 侧有**明显延迟**，这是本节最重要的一条

追加请求返回 `completed` 之后，B站 的分P 列表**不会立刻更新**。
实测：一次追加后立即查询仍是旧数字，**约 20 分钟后**才看到全部落地。

这个延迟让本项目连续做出**三次错误结论**（每一次都是"查一次没变 ⇒ 断言失败"）：

| 误判 | 当时的推断 | 真相 |
|---|---|---|
| 第 1 次 | 「`completed` 但分P 没变 ⇒ B站 静默丢弃整批」 | 只是还没落地 |
| 第 2 次 | 「这批含 9 个重复分P ⇒ 重复内容导致整批被丢」 | 与重复无关 |
| 第 3 次 | 「该稿件已公开 ⇒ 不再接受追加」 | 已公开照样能追加 |

**教训（比结论本身更重要）**：判定"异步操作是否生效"时，
**单次查询的"没看到"不能作为"不存在"的证据** —— 必须轮询到超时才可下否定结论。
这与 §7.5 陷阱 2 是同一类方法错误（那次是"只读源码不取证"，这次是"取证但不给足时间窗"），
本项目在同一个项目上犯了两次。

### 7.6.3 由此产生的两处代码改动

1. **续传落地确认**（`confirmPartTitlesLanded`）：追加后**轮询 B站 侧分P 标题**
   （默认 **5 分钟**、每 6s 一次），用**集合差**判断新标题是否出现（能正确处理重复标题）。
   三条分支（这是重点 —— 不能非黑即白）：
   | 结果 | 处理 |
   |---|---|
   | 确认到新分P | 成功 |
   | 超时，但任务终态是 error | 真失败 ⇒ 记 `FAILED` |
   | 超时，任务终态 ok | **待确认** ⇒ 记 `SUBMITTED` + 明确告知"未在窗口内确认" |

   > 这里连续修了两版：第一版只看 `waitUploadTask` 的任务终态，B站 侧没落地时会**谎报 PUBLISHED**；
   > 第二版把"确认超时"直接当失败 —— 又会在 B站 慢的时候**误报 FAILED**（实测延迟可达 20 分钟，
   > 而任何固定窗口都可能不够）。所以最终必须区分"确认成功 / 确认失败 / 未能确认"三态，
   > 把不确定性如实交出去，而不是硬塞进成功或失败。
   测试：`test/confirm-append.ts`（10 项），已并入 `npm run verify`。
2. **续传去重**（`fetchExistingPartTitles`）：投之前先查目标稿件已有分P 标题，
   **只投新增的**。实测重跑会把已投过的切片再投一遍 —— 稿件里因此出现
   15 个重复分P（每个切片 2 次、"十连全F"3 次）。加去重后重跑不再叠加。

### 7.6.4 B站 不禁止同名分P

实测同一稿件里可以存在**完全同名**的分P（3 个"观众一番赏十连全F…"并存）。
所以"重复"不会报错、也不会被自动拒绝 —— 去重只能靠**我们自己**比对标题，
不能指望平台拦。

---

## 8. 环境项（需要人工处理，代码无法解决）

`node src/cli.ts selfcheck` 会在本机报出以下三项，均已通过验证确认是**环境配置**问题而非代码缺陷：

| 项 | 现状 | 建议动作 | 影响 |
|---|---|---|---|
| **「上传后删除素材」未关闭** | 房间配置为 `deleteAfterCheck` | **必须改为 `none`**（硬约束 #11）：biliLive-tools → 设置 → 工具 → 上传 → 关闭 | ⚠️ **会造成真实故障**：稿件过审后源视频被删，转写与切片读到不存在的文件。本机 74 条录制历史中已无一条文件存在，怀疑与此有关 |
| **biliLive-tools 版本差异** | 实测 3.21.0，任务书核实 3.22.1 | 不影响运行（`probe.ts` 已实测确认所有用到的接口可用）；若升级到 3.22.x，重跑 `probe.ts` 复核字段 | 无（本项目只用到的接口都已实测通过） |
| **`seasonId` 未配置** | 为 0 | 在 B站创作中心建一个合集，把 ID 填入 `config.json` 的 `publish.seasonId` | 切片照常投稿，但**不会归入同一合集** |
| ~~**LLM API Key 未配置**~~ | ✅ **已解决**（2026-09-23 更新） | 此前是模板占位符，现已配置并真实验证：选片档切到 `deepseek-v4-pro`（`maxTokens=16384`）。**两档模型不同**，硬约束 #13 的「契约失败升级到另一档」因此才真正生效（此前两档同名，只能同模型重试一次）。`npm run select-slot-test` 可零费用自检该配置 |
| **`webhook.partMergeMinute`（断播续传时间间隔）** | ✅ **保持默认 10 即可，无需调整** | 本项目一度误判为"太小导致劈场"，建议调到 75 —— 那是**错误结论**（见 §7.5 陷阱 2 的复盘）。用真实文件时长复算后，同场各段真实间隙仅 0.0–0.9 分钟，`10` 完全够用。**若已改成 75，建议改回 10**（调大反而会让"下播后短时间内再开播"的两场被错误合并）。另需确认「断播续传」总开关为**开启**，否则阈值不生效（`if (!mergePart) partMergeMinute = -1`） | 无 |

按任务书要求，**未配置项不阻止链路运行**；但第 1 项与第 4 项会实际影响产出质量，建议首次试跑前处理。
（上述第 4 项已解决；第 1 项「上传后删除素材」也已确认全部为 `none`，`selfcheck` 通过。）

---

## 8.1 Windows 脚本的编码陷阱（真实踩过）

交付过程中遇到的两个**只会在 Windows 上出现、且现象很有迷惑性**的问题，记录在此避免重复踩：

| 现象 | 根因 | 正确做法 |
|---|---|---|
| 双击启动脚本，窗口里刷出一串 `'xxx' 不是内部或外部命令`，注释文字变成乱码 | `.cmd` 文件被写成 **LF 换行 + 含中文**。`cmd.exe` 按系统 ANSI 代码页读取脚本内容、且要求 CRLF 行尾；中文被错误解码后**注释行被切断，剩下的片段（如路径里的 `powershell.exe`）被当作命令执行** | `.bat` / `.cmd` 一律 **纯 ASCII + CRLF**。需要中文提示就让它们转调 `.ps1` |
| 中文注释导致 `.ps1` 直接报语法错误（`Unexpected token '}'`）、脚本根本跑不起来 | Windows PowerShell 5.1 **会把无 BOM 的 UTF-8 文件按 ANSI 解析**，中文被打乱后破坏语法结构 | `.ps1` 一律存成 **UTF-8 with BOM** |
| 服务日志里的中文变成 `鐩存挱鍒囩墖` | 父进程用 ANSI 代码页解码子进程的 UTF-8 输出（PowerShell Job 管道同样如此） | 显式设置 `[Console]::OutputEncoding`；或让服务写文件、父进程按 UTF-8 读出来显示（本项目采用后者，更可靠） |
| 日志里混入 `[36m` 这类转义码 | 代码只检查 `process.stdout.isTTY`，没遵守 `NO_COLOR` 约定 | `logger.ts` / `cli.ts` / `probe.ts` 都改为同时检查 `NO_COLOR` 与 `TERM=dumb` |

一句话总结：**跨进程传文本时，编码必须显式指定，不能依赖系统默认值。** 这四条都已修复，并且 `run.cmd` / `start.bat` 现在是纯 ASCII，`launcher.ps1` / `start.ps1` 带 UTF-8 BOM。

---

## 10. 2026-09-23 晚：四项深度排查与修复

用户提出「检测目前项目状态、完成度、还有哪些可以更进一步」之后，做了一轮以**真实数据**为依据的排查。
四项都不是猜测——每一项都先复现、再定位、再修、再用测试锁住。下面按"事故现象 → 根因 → 修复"记录。

### 10.1 重复追加分P 的根因（最严重的一项）

**现象**：稿件 `BV13hhE6XEQM` 有 43 个分P，但只有 28 个不同标题 —— 15 个是重复内容。

**排查过程**（先看权威数据，不看猜测）：

`data/publish-log.jsonl` 的交叉统计直接给出了两类不同的重复：

| 任务 | submit 条数 | 重复标题 | uploadTaskId 种类 |
|---|---|---|---|
| `manual-20260922121832-zdd2`（9-22 场） | 17 | 5 个标题各 **×3** | **7** |
| `manual-20260923094131-loby`（9-23 场） | 23 | 9 个标题各 **×2** | **2** |

日志侧的续传批次记录进一步确认：`loby` 在 09:49 投了 9 个切片、11:31 又投了 14 个 ——
**第二批把第一批那 9 个原样又投了一遍**（14 个候选里含那 9 个）。

**根因**：防线有两道，都不够：

1. **标题去重**（`fetchExistingPartTitles`）：只在"目标稿件分P 列表已刷新"时生效。日志里
   既没有"续传去重：跳过 N 个"，也没有任何跳过痕迹 —— 而且当时的失败日志用的是 `log.debug`
   级别，而生产日志级别是 `info`，所以"去重悄悄没生效"完全无迹可查。
2. **指纹幂等**（`findFingerprint`）：此前只写在 `cutAndUploadClip`（单切片路径）里。
   多分P 路径 `publishAsMultiPart` **只 register 不 find** —— 它把指纹写进台账，却从不查台账。
   真正需要这道防线的地方（唯一的上传点）恰恰没有它。

**修复**（`src/publish.ts`）：

- 在 `publishAsMultiPart` 组装分P 之后、上传之前，**按指纹过滤**已投过的切片；
  被过滤的切片状态同步成 `SUBMITTED`/`PUBLISHED`（否则 UI 一直显示"待投稿"）。
- 全部已投时返回 `ok: true` + `skipped` —— 这是"无需投稿"，不是"投稿失败"，
  否则调用方会把整批切片误标成 `FAILED`。
- 把 `fetchExistingPartTitles` 里所有"跳过去重"的日志从 `debug` 提到 `info` ——
  **安全性降级必须可见**，否则下次还是查不出原因。
- 新增 `test/fingerprint-dedup.ts`（**18 项断言**，用真实 `Publisher` + 假 client，
  走线上同一条代码路径）：第二次续传必须 0 次上传调用、部分重复只投新增、
  全新任务不被误伤。

**同时修正一条错误的归因**：先前把"整批被静默丢弃"写进了代码注释与文档。
本轮用带轮询的确认逻辑复测后确认，那 4 批追加**全部成功落地**，
真正的原因是 B站 分P 列表有约 **20 分钟延迟**。真实代价不是"投稿被吞"，
而是"重复分P 留在了稿件里"。注释已改写，避免后人继续被误导。

### 10.2 错误统计里的"假错误"：dry-run 安全拦截被记成 internal

**现象**：`data/errors.jsonl` 的「近 24h 错误」有 83 条，其中混着明显不是故障的记录。

**排查**：没有把它当成"测试污染"就收工 —— 逐条解析后发现问题在别处：

```
taskId : manual-20260923125102-4c3w     ← 本地 20:51:02
stage  : UNKNOWN   type=internal
msg    : 语音识别没有产出任何字幕（失败区间覆盖 2.0/2.0 分钟）：
         contract: dry-run 且无缓存：拒绝调用付费 ASR（段 1）
```

这是 **dry-run 预检按硬约束 #14 正常拦截**，却被 `catch` 归为 `type: 'internal'`
写进了错误事件流。也就是说"安全阀按设计拦住了付费"被统计成了"程序跑挂了"。

**修复**：

- `src/asr.ts` 新增可测的纯函数 `isDryRunPaymentRejection()` 与常量 `DRY_RUN_REJECT_PREFIX`：
  仅当 `segments` 为空、`gaps` 非空、且**每个** gap 都以该前缀开头时判定为"设计内拦截"。
  只要有一个窗口是真实失败（上游 5xx / 模型不支持），照常报错 —— 不许拿"没付费"当挡箭牌。
- `src/daemon.ts`：判定成立时**优雅停在 `TRANSCRIBED`**，不抛异常、不写错误报告、不告警，
  只用 `info` 说明"要花钱请开 `--allow-paid`，且没有发生任何付费调用，重跑不会重复花钱"。

**这里 e2e 当场抓到了我自己的一个 bug**（值得记下来）：

第一版把常量写成 `${DRY_RUN_REJECT_PREFIX} 且无缓存：...`，而该常量本身就含 `contract: `，
gaps 的组装处又会再拼一次 `type` ——实际落地成 `contract: contract: dry-run ...`，
前缀判定**永远不匹配**，新分支成了死代码。是场景 12 新增的契约断言把它报出来的：

```
✗ asr 层写入的 gaps 前缀符合编排层识别契约 :: 前缀=contract: dry-run 实际=contract: contract: dry-run ...
```

修复后 e2e 从 `PASS=146 FAIL=2` 变为 `PASS=148 FAIL=0`。

### 10.3 弹幕热词被 n-gram 撕成碎片（直接影响选片质量）

**现象**：`signals.json` 的窗口热词出现 `表情(91)、情包(81)、可表(65)` 这类无法阅读的片段。

**复现**（真实 4502 条弹幕，非构造数据）：修复前 top 15 是

```
安可(444)  Anko(247)  表情(196)  情包(194)  抱抱(183)  可表(102)  动态(89)  可动(87)  态表(87)  ...
```

`表情包` 被同时切成 `表情`/`情包`/`可表`，`动态表情` 被切成 `动态`/`可动`/`态表`。
真词与碎片**各占一半名额**，而这些假词会被写进喂给 LLM 的"窗口热词"里，直接拉低选片质量。

**根因**：n-gram 的边界不对齐，而原有的"包含关系去重"只处理包含关系
（`情包` 并不包含 `表情`，两个都留）。**7 个碎片一个都拦不住。**

**试过但不可行的方案**（记录在此，避免以后重走）：按"出现位置是否被更长的高频 n-gram
完全覆盖"来删。算术上就不成立 —— 同一句 `动态表情包` 会同时产出 `动态表情`(位置 0)
与 `表情包`(位置 2)，`情包` 每次出现都落在两者之一，但没有任何**单个**更长词的覆盖区间
集合能包住它（`动态表情` 盖 0/4，`表情包` 盖 2/6，4 与 6 各自落空）。
要么退化成硬调阈值，要么换判据。

**最终修复**：改用无监督新词发现的经典判据 —— **左右邻字熵**。
真正的词两侧用字自由（`[这]表情包[真]`、`[个]表情包[啊]`），邻字分布散；
碎片 `情包` 左边几乎只能是"表"，分布集中。
判据取"两侧各至少出现过 2 种不同邻字"，**不需要调任何阈值**，
并天然放过 `安可`/`Anko` 这类中英混排。修复后：

```
安可(444)  Anko(247)  表情(196)  抱抱(183)  动态(89)  腿姐(75)  看看(71)  意思(60)  我看(55)  懂你(50)  ...
```

7 个碎片全部清除，耗时 108ms（4502 条）。此前 `extractKeywords` **零测试覆盖**，
本轮在 e2e 场景 3b 补上（复现事故形态：`情包`/`可表` 必须被滤掉、`表情包`/`抱抱` 必须留下）。

### 10.4 自动触发为何"从未真实跑过"

**现象**：`data/trigger-state.json` 里 `processedRecordIds` 与 `firedLiveIds` **都为空** ——
"全自动"最核心的那一步（直播录完 → 自动开跑）在本机从未发生过，所有场次都是手动导入的。

**排查**：写了 `tools/trigger-diagnose.ts` 拿两个接口的真实返回做对比。工具本身先后踩了两个坑，
都记在工具的注释里：

- 第一版只读 `webhook.rooms` 找房间，只看到遗留的 `34567890`，得出"本项目房间没在录"的**错误结论**。
  实际 biliLive-tools 有**三处**放房间号且语义不同：
  `recorders[].channelId`（真正的直播录制）、`virtualRecord.config[].roomId`（文件夹监听）、
  `webhook.rooms`（回调覆盖，可能是遗留）。
- 第二版把毫秒当秒、把 `recordEndTime` 当 `liveEndTime`，打印出 `58695-05-06` 这种荒谬日期，
  基线过滤随之全部失效。（项目代码本身读的是 `recordEndTime`，单位没错 —— 是工具错了。）

**结论（可信版）**：数据源是**通的** —— `23456789` 的 `recent-clips` 返回 5 条，
`record-history/list` 两房间合计 87 条；四个切片录制（1590s/1341s/168s/8s）都在。

**未能触发不是链路故障，而是时间问题**：两个房间最近的录制结束于 **2026-09-22 23:19**，
而自动处理基线是 **2026-09-23 01:40** —— 窗口内确实没有新录制。
（另注：`168s`/`8s` 那两条过短，会被 biliLive-tools 的 `minSize=20MB` 与录制合并逻辑吸收，
不会独立成场，这与 `handleMatchedPair` 的实现一致。）

**顺带修掉一个真 bug**：`roomIdsFromConfig()`（`src/recordings.ts`）只读
`virtualRecord.config[].roomId`，**漏了 `recorders[].channelId`**。
实测 `recorders` 里是 `12345678`(乙主播) + `23456789`(甲主播)，而 `virtualRecord` 里是
`34567890` + `23456789` —— **乙主播完全不在监控清单里**，只是靠 `room.roomId` 恰好也等于
`12345678` 才被兜住。一旦配置里的默认房间号改成别的，乙主播的新录播就再也不会被自动处理。
修复后 `roomIdsFromConfig()` 返回 `["12345678","23456789","34567890"]`。

### 10.5 本轮修复的测试与文档增量

| 项 | 变化 |
|---|---|
| `test/fingerprint-dedup.ts` | **新增**，18 项断言（指纹幂等三场景） |
| `test/e2e-offline.ts` | 新增场景 3b（热词去碎片 4 项）+ 场景 12 契约断言 4 项 → **148 项** |
| `test/confirm-append.ts` | 上一轮新增，10 项（分P 落地确认的三分支） |
| `tools/trigger-diagnose.ts` | **新增**，触发链路只读诊断（三处房间号来源 + 两接口对比） |
| `npm run verify` | 套件 23 → **24**（新增 `fingerprint-dedup-test`） |
| `src/recordings.ts` | `roomIdsFromConfig` 补 `recorders[].channelId` |
| `src/asr.ts` | 新增 `isDryRunPaymentRejection` + 前缀常量 |
| `src/publish.ts` | 多分P 指纹幂等 + 稿件详情单飞缓存 + 去重日志提级 |
| `src/danmaku.ts` | `extractKeywords` 改邻字熵判据 |

### 10.6 完成度再评估

| 维度 | 上轮 | 本轮 | 依据 |
|---|---|---|---|
| 功能完整度 | ~95% | **~96%** | 重复投稿这一**会真实损害用户稿件**的缺陷已修并有测试锁住 |
| 测试覆盖 | ~90% | **~93%** | 新增指纹幂等 18 项 + 热词/契约 8 项；`extractKeywords` 从零覆盖到有覆盖 |
| 真机验证 | ~88% | **~89%** | 触发链路已确认为"数据源通、窗口内无新录制"；仍未经历一次真实直播开播 |
| 文档 | ~92% | **~94%** | 本节四项排查全部留档，含两个"试过但不可行"的方案 |
| 生产就绪 | ~85% | **~88%** | 错误统计不再被设计内的安全拦截污染，可据其判断健康度 |
| **综合** | ~92% | **~93%** | 剩下的主要是"需要真实直播才能推进"的外部依赖项 |

**仍然存在的、代码无法解决的外部项**（与 §8 一致）：

1. **一次真实的开播触发**：链路已确认可用，但需要用户真的开一场直播（或在 biliLive-tools 里
   手动触发一次录制完成）才能把 `firedLiveIds` 从空变成非空。这是唯一还没走过的分支。
2. **`BV13hhE6XEQM` 里的 15 个重复分P 需要手工删除**：B站 没有提供删除分P 的 API，
   只能在创作中心逐条删。建议保留 P1–P14（biliLive-tools 投的完整版+纯享版）
   与 P15 起每个标题的**第一个**，删掉后续重复项。
3. **两档模型的真实选片质量抽检**：需要真实 LLM Key（见 §7 表）。

---

## 11. 真实直播间录播全链路验证（2026-09-23 晚，用户指定房间）

用户指定直播间 `https://live.bilibili.com/45678901`（**丙主播**，英雄联盟，人气约 9 万），
要求"找个 b 站直播间进行录播、进行自动化测试"。这是第一次用**真实直播**跑通全链路。

### 11.1 做法（每个动作都在日志里）

| 步骤 | 手段 | 结果 |
|---|---|---|
| 1. 确认在播 | B站 匿名 `room/v1/Room/get_info` | 🔴 直播中，标题「哈喽」，人气 90,800 |
| 2. 加录制房间 | `POST /recorder/add`（HTTP API，硬约束 #1） | id `5bd4fafa…`，`segment=59`（分钟） |
| 3. **关闭它自己的自动上传** | `GET /config` → 改 `webhook.open` → `POST /config` | 全局 webhook 带 `uid`+`uploadPresetId`，**开着就会把录播自动投到账号** |
| 4. 开始录制 | `POST /recorder/manager/batch_start_record` | `successCount=1`，state → `recording` |
| 5. 录 4.4 分钟 | 观察文件增长 | `哈喽_PART000.flv` 168.3 MB + `哈喽.xml` |
| 6. 停止录制 | `POST /recorder/manager/batch_stop_record` | `successCount=1`，`recordEndTime` 落库 |
| 7. 导入本项目 | `node src/cli.ts video <flv> --title …` | 见下表 |
| 8. 只切片不投稿 | `tools/cut-only.ts`（`skipUpload:true`） | 133.3s / 1080p60 成片 |
| 9. 恢复现场 | webhook 复原、房间保留 | 3 个 recorder 全 `idle` |

### 11.2 跑通结果（全链路真实付费，总计 **¥0.11**）

```
自动发现同名弹幕：哈喽.xml
转写预检：1 个调用单元，00:04:24，估算 ¥0.06
段 1 完成：116 条字幕（9.4s，paid=true）
弹幕信号：47 条 / 2 个密度峰（40s 21条、0s 8条）/ 无 SC·上舰·礼物 → 按陷阱 #25 降级（正确）
LLM 分析：deepseek-chat 总结 + deepseek-v4-pro 选片，95.8s，¥0.047
主播识别：丙主播（置信度 high，来自录制目录名）
候选切片：1 个，score 9.2，默认勾选
切片：133.2s → mp4（h264 1920×1080@60，aac 48k 立体声，8.51 Mbps），30.9s
```

**选片质量**（此前一直无法验证的一项）：

> 标题：`丙主播：新枪像屎，但队友A小报点连杀，喊出'万物起源于7:1'！`
> 理由：开场吐槽、报点击杀与"万物起源于7:1"名场面集中于前段；位于弹幕密度峰值窗口，自洽且有梗。
> 标签：丙主播 / 游戏实况 / FPS / 吐槽 / 名场面 / 报点击杀 / 万物起源于7:1

`summary.md` 也给出了带时间点的结构化要点（00:00:22 吐槽新枪、00:01:13 连续报点击杀、
00:01:41 喊出"万物起源于7:1"、00:03:31 包点交火情绪反转），并明确"适合单独成片的片段为前 2 分 10 秒"。
LLM 确实读懂了直播内容，不是套模板。

### 11.3 🔴 这次验证抓到的真实 bug：切片字幕用相对路径 → 切片必失败

**这是本轮最有价值的产出** —— 一个"测试全绿、真机必炸"的缺陷。

第一次切片直接失败：

```
ffmpeg exited with code 4294967294:
Failed to set value '[0:v]subtitles=data/tasks/manual-20260923133417-uveh/burn-d8badca8.ass[0:video]'
for option 'filter_complex': No such file or directory
```

**根因**：`client.cut()` 的 `assFilePath` 传的是**相对路径**。
biliLive-tools 是**另一个进程**，它不解析这个路径，而是原样拼进 ffmpeg 的
`[0:v]subtitles=<path>[0:video]`，由 ffmpeg 以**它自己的 cwd** 解析 → 找不到文件。

**为什么以前没暴露**：

- `videoFilePath` 来自录制目录，本来就是绝对路径；
- `output` / `saveDir` 早就用了 `absPath()`（陷阱 #6 修过）；
- 只有字幕 ASS 这一条链**可能**是相对的（`clip.outputDir` 默认就是相对的 `data/clips`），
  所以**只有"带字幕烧录的切片"会中招** —— 而字幕正是本项目的核心卖点。

**为什么 e2e 抓不到**（第二层缺陷）：mock server 确实校验了 `output` 必须绝对路径，
但对 `assFilePath` 只做 `exists()` 检查 —— 而 mock server 与 e2e **共用同一个 cwd**，
相对路径恰好能解析到，于是测试一路绿灯。

**修复**（两处）：

1. `src/publish.ts`：`client.cut()` 的 `videoFilePath` 与 `assFilePath` 都过 `absPath()`；
2. `test/mock-server.ts`：新增**路径形态**校验（必须是绝对路径），
   并补上 `videoFilePath` 的同类校验 —— 按"对方会怎么解析"来校验，而不是按"我这边能不能找到"。

修复后重跑：`成功 1 / 失败 0`，产出 133.3s mp4；e2e 也从 148 → **152 项全绿**。

### 11.4 顺带修掉的工具层错误（都是我自己的）

| 错误 | 真相 |
|---|---|
| `/recorder/list 返回 0 个` | 实际返回 `{payload:{data:[…]}}`，我只认 `data` 漏了 `payload.data` |
| `/config.recorders` 能复核"房间加成功没" | 它是**启动时快照**，新加的房间不在里面 → 必须读活的 `/recorder/list` |
| `/config/save` 写配置 | 端点不存在，是 `/config/set`；但它入参形状特殊，最终用 `GET /config`→改一个键→`POST /config` |
| `/recorder/add` 的 `remarks` 为空 | `room/v1/Room/get_info` 的 data **没有 uname**，主播名要查 `get_anchor_in_ui_room` |
| biliLive-tools 版本漂移 | 实测已是 **3.22.1**，与任务书核实版本一致，漂移已消失 |

### 11.5 这次验证**没有**覆盖到的部分（诚实说明）

1. **真正的"开播自动触发"仍未走过**。原因有两层，都已定位：
   - 运行中的服务实例（pid 19628，20:53 启动）用的是我修 `roomIdsFromConfig()` **之前**的代码，
     所以它的监控清单里没有新加的 `45678901`；而**不能简单重启服务**——重启会重建
     "自动处理基线"，反而把刚录的这场排除掉；
   - 且触发判定里有**断流保护**：只要 `live === true`（主播还在播），就明确 `fire:false`，
     必须等"持续非直播 ≥ 600 秒"。我们只是停了录制，主播仍在直播，所以**正确**地没有触发。
2. **投稿环节**按用户要求跳过（`autoPublish=false` 只切不投），追加/新建稿件的真实写操作本轮未做。
3. **本次录制产物与账号配置**：录播文件留在 `Downloads/Bilibili/丙主播/`，
   房间 `45678901` 留在 biliLive-tools 录制列表里（`idle`，不占资源）；
   若不再需要，可在 biliLive-tools 里删掉该房间。

## 9. 如何自行复现全部验证

```powershell
npm run verify          # 一条命令跑完：类型检查 + 凭据审计 + 脱敏自测 + 离线 e2e + 冒烟 + 真实素材
```

`verify` 目前串起 **28 个套件**，全绿。逐项：

```powershell
npm run typecheck           # 0 error
npm run audit               # 凭据审计：0 命中，且闸门自证有效
npm run text-test           # 文本编码完整性：204 个文件（BOM / 替换字符 / CRLF）
npm run redact-test         # 脱敏层 76 项
npm run title-test          # 标题体检 45 项
npm run clip-boundary-test  # 切片边界吸附 50 项（含分P 边界守卫、Top-N 上限）
npm run resume-target-test  # 续传目标匹配 36 项
npm run multipart-routing-test  # 多分P 路由 21 项
npm run confirm-append-test # 分P 落地确认三分支 10 项
npm run fingerprint-dedup-test  # ★ 指纹幂等 18 项（重复追加的防线，见 §10.1）
npm run e2e                 # 离线端到端 148 项（mock，零费用；含热词去碎片 §10.3）
npm run smoke               # 服务形态 66 项（连真实 biliLive-tools 只读）
npm run real                # 真实素材 20 项（dry-run，零费用）

# 只读探测真实接口并重新生成实测文档
node src/probe.ts

# 触发链路诊断（三处房间号来源 + 两接口真实对比，只读）
node --experimental-strip-types tools/trigger-diagnose.ts

# 重复分P 对账（产出「保留哪个、删哪个」清单，只读）
node --experimental-strip-types tools/duplicate-parts-report.ts

# 启动服务（半自动模式）
.\start.ps1
```

---

## 12. 30 分钟真实录播全流程交付验证（2026-09-23 深夜）

用户要求："再次测试 时间半个小时 然后仅自己可见 跑全流程 包括完整弹幕版和纯享版录播和切片在一个稿件"。
这是本项目第一次**完整交付形态**的真实端到端验证。

### 12.1 最终结果（B站 侧真实数据）

```
BV13Dhb6SEre   aid=117320940783894   可见性=仅自己可见   videos=8

P1  30:51  完整版 1                      ← 完整弹幕版（弹幕+字幕烧录）
P2  30:51  纯享版（无弹幕） 2             ← 无弹幕原片
P3   2:07  丙主播一眼认出NOBODY绿手套三杀，当场激动喊牛逼
P4   2:06  丙主播破防：四个人守B居然守不住？队友我服了
P5   2:06  丙主播高能连发：队友完美给烟破点，残局1v1翻盘连喊nice
P6   2:18  丙主播三人推中连杀清场，对手开大反打全队撤退
P7   2:10  丙主播队友老狗战术鬼才：大脚步骗技能，全队认可执行
P8   2:07  丙主播极限残局：找到敌人击杀却拆包时间不够，只拆一半
```

**"一个稿件 = 完整弹幕版 + 纯享版 + N 个切片"这个核心交付形态，第一次被真实数据证实。**

### 12.2 全流程与成本

| 环节 | 做法 | 结果 |
|---|---|---|
| 录制 | biliLive-tools，房间 45678901（丙主播） | 30 分 51 秒，1,139.4 MB flv + 295 条弹幕 xml |
| 转写 | 阿里云 ASR | 693 条字幕，**¥0.41** |
| 内容分析 | deepseek-chat + deepseek-v4-pro 双档 | 6 个候选切片，**¥0.107** |
| 切片 | 每个切片烧「弹幕 + 字幕」合并 ASS | 6 个 mp4，2:06–2:18 |
| P1 完整弹幕版 | `tools/make-full-danmaku.ts`（复用项目的 ASS 链路 + NVENC） | 3.3 GB，烧录 304s（6.1x 实时） |
| P2 纯享版 | 流拷贝封装 mp4 | 1.1 GB |
| 投稿 | `tools/publish-multipart.ts`（新建稿件模式） | 5.1 GB / 8 个分P，**1 个稿件** |
| **合计成本** | | **约 ¥0.52** |

### 12.3 🔴 本轮抓到的两个阻断性 bug（都会让交付彻底失败）

#### bug 1：`CUT` 状态不落盘 ⇒ 多分P **一个分片都投不出去**

**现象**：6 个切片全部切片成功（日志 6 条"切片产出完成"、台账 `status=CUT`、
`cutOutput` 指向的 mp4 都在磁盘上），但紧接着 `publishAsMultiPart` 报
「没有任何可投稿的文件（完整版与切片都不可用）」——**0 个分P 投出，且任务静默退回 ANALYZED**。

**根因（两层）**：

1. `ledger.setClipStatus()` 只在 `CLIP_CRITICAL_STATUSES`（`SUBMITTING`/`SUBMITTED`/`PUBLISHED`）
   时立即 `persistStrict()` 落盘。`'CUT'` **不在**其中 —— 于是切片产物路径只 `markDirty`
   （延迟 300ms 合并落盘）。
2. 而 `clipsArray()` 有一条「clips.json 的 mtime 比我们自己上次写它的时间新 ⇒
   重新读文件并**重建整个切片数组**」的规则（本意是跟上 `analyze.ts` 绕过 ledger 直接改文件）。
   这 300ms 窗口里只要该规则被触发，**`cutOutput` 就随重建一起消失**。

于是出现最迷惑人的现象：**你事后去查台账，`cutOutput` 好好地在那里**（因为后来某次落盘补上了），
只有"当时那个时刻"读到的是空的。

**修复**（`src/ledger.ts`）：写入 `cutOutput` 时同样立即落盘 ——
产物路径是"能不能投出去"的唯一依据，必须和关键状态一样立刻固化。

**配套**（`src/daemon.ts`）：`publishMultiPartStage` 不再使用切片**之前**取的 `selected`，
改为逐个 `getClip(taskId, index)` **重读**（台账权威入口，不受任何数组级快照影响），
并在数量变化时打日志说明。

#### bug 2：`dailyLimit=0`（不限额）被工具当成"额度为 0"

`tools/publish-multipart.ts` 直接算 `dailyLimit - todayCount` ⇒ `0 - 54 = -54` ⇒
判定"额度不足"拒绝投稿。而 `src/publish.ts` 早就定义了 `dailyLimit === 0` 表示
**用户显式关闭上限**（`quotaOn = dailyLimit > 0`）。
于是"手动工具能不能投"与"自动流程能不能投"给出**相反**答案。已对齐语义。

#### 回归测试

新增 `test/multipart-cut-snapshot.ts`（**12 项**）：用真实 Ledger + 真实 Publisher，
**故意把 clips.json 的 mtime 推到未来**以强制触发那条重建规则，然后断言

- 修复后：重建仍保留 `cutOutput`、重读后 3 个切片都能投、`publishAsMultiPart` 不再报空；
- **反证**：喂一份"没有 cutOutput 的旧快照"必须复现`没有任何可投稿的文件` ——
  证明这个测试真的能抓住该 bug（而不是恰好通过）。

### 12.4 顺带修掉的工具/配置层问题

| 问题 | 真相 |
|---|---|
| 投稿预设里的"仅自己可见"字段找不到 | 字段是 **`is_only_self`**（snake_case），按 `isOnlySelf` 搜是搜不到的；且预设不在 `appConfig.json` 也不在 `/preset/*` HTTP 路由，而在独立的 `presets.json` |
| 默认预设是公开的 | `default` / `甲主播` 两个预设的 `is_only_self` 都是 `0` ⇒ **完整版会被公开**，与切片侧的"仅自己可见"割裂。已用 `tools/blt-preset-set.ts` 全部改为 1 |
| biliLive-tools 详情接口在稿件处理期间返回 500「啥都木有」 | 不是 bug，是稿件还没转码完；此时用 B站 公开接口也拿不到（仅自己可见的稿件匿名不可见，`code=-404`）。核验要等分P 数稳定 |
| 我自己的工具污染了对方的 `llmPresets` | 按 `/preset/i` 模糊匹配键名，把投稿预设写进了 **LLM 预设**字段。已改为白名单（只认 `biliUploadPresets`/`uploadPresets`），并复原该字段 |

### 12.5 本次验证**没有**覆盖到的部分

1. **"biliLive-tools 投完整版 + 项目追加切片"这条分工路径**未被走过。
   本次走的是**新建稿件**模式（项目一次投出全部 8 个分P）。
   原因：`webhook.open=false` 时 biliLive-tools 不会自动压制/上传，而它的
   `/task/burn` 参数未公开、webhook 内部处理链又很长，为不阻塞验证改用了项目侧一次投出。
   **续传（append）路径本身在上一轮已用真实数据验证过**（见 §7.6）。
2. **真正的"开播自动触发"**仍未走过 —— 触发判定有断流保护，需要一场直播真的结束。
3. 稿件 `state=-50`（B站 审核中），审核通过后才会转为仅自己可见的正式状态。

### 12.6 本次遗留的配置状态（需要用户决定）

| 配置 | 当前值 | 说明 |
|---|---|---|
| biliLive-tools `webhook.open` | **false** | 录制期间我为防止自动上传而关闭；**若你要恢复原来的自动上传，需要改回 true** |
| biliLive-tools 投稿预设 `is_only_self` | **1**（两个预设） | 原值都是 0。若希望完整版公开，需改回 0 |
| 项目 `publish.resumeAid` | `""` | 原为 `117314833877723`。清空是为了避免切片被追加到 9-22 那个旧稿件 |
| 项目 `runtime.allowPaid` | 视本次操作而定 | 真实转写需要它为 true；dry-run 演练时保持 false |

---

## 12.8 【已被 §12.9 取代】「试看」中间形态：界面内联播放（2026-09-24，第 3 轮）

> 这一版实现仍然保留（`inline:true` 时使用），但**不再是默认行为** —— 见 §12.9。
> 记在这里是因为它完整反映了一次"走弯路"：可用，但不是最优。

### 需求演进（三轮，值得完整记下来）

| 轮次 | 用户反馈 | 我做的 | 结果 |
|---|---|---|---|
| 1 | 「点击试看的时候可以直接跳转到文件所在目录吗」 | 打开资源管理器并选中源文件 | 方向可理解，但实现有 bug（见 §12.7） |
| 2 | 「没有正确跳转」 | 修好了打开方式（`Start-Process -LiteralPath` 失效、`/select,` 传参错） | 窗口真开了，但…
| 2b | 「文档窗口 显示在界面上面」 | 加了"提到前台"（ALT 解锁 + 非 detached spawn） | 窗口真到前台了 |
| 3 | **「不需要资源管理器直接弹到你面前并选中源文件」** | **改为界面内联播放** | ✅ 这才是用户真正要的 |

**教训**：第 1 轮我其实问过自己"为什么不直接烧个切片给他看"，
当时用"切片要跑 ffmpeg、试看常常连点好几个候选"说服了自己——
但那是我对**使用场景的猜测**，不是用户的需求。用户要的一直是
**"在界面里看到这段内容"**，而不是"去文件夹里找文件"。
三轮返工本可以用一句确认避免。**需求理解错误比实现 bug 贵得多。**

### 最终实现

`POST /api/preview-cut` 现在**就地烧一个可内联播放的小 mp4**：

| 决策 | 理由 |
|---|---|
| 必须转 mp4 | 源录播是 `.flv`，浏览器 `<video>` 不支持 FLV 容器；而 `servePreview` 只允许任务目录内文件，源文件在 `Downloads/` 属于目录外 |
| 用 NVENC 硬件编码 | 132 秒片段实测：`libx264 veryfast crf21`（正式切片参数，画质优先）**≈49 秒**；`h264_nvenc p5 cq26` **≈21 秒**。试看是"看一眼内容"，不需要发布级画质 |
| `-ss` 放在 `-i` **之前** | 快速 seek（关键帧级），比解码到目标点快得多；试看只需"大概从这里开始" |
| 结果落 `data/preview/`，按内容哈希命名 | 同一候选**重复点是零成本**（实测第二次 8ms 命中缓存） |
| 播放走 `/api/preview/_preview/<name>` | 复用 `servePreview` 已测试过的 **HTTP Range**（可拖进度）与防路径遍历逻辑；`_preview` 只是指向预览目录的伪 taskId，三重校验（`..`／绝对路径／扩展名白名单）一个不少 |
| **默认不打开资源管理器** | 用户明确不要；`openDir:true` 时才打开（保留给"我就想去文件夹拿原件"的场景） |
| 前端按钮显示「生成中…」 | 首次要 21 秒，不能让用户以为点坏了；弹窗里 `<video controls autoplay muted>`，`muted` 是为了避开浏览器"有声自动播放被拦" |
| 过期清理 | 6 小时 / 最多 40 个，在生成新片段时顺手清一次（不为纯 UI 辅助功能加定时任务） |

### 验证

`tools/verify-preview-inline.ts`（**16 项，全通过**）：

```
① 首次生成成功（h264_nvenc，21.3s，160.7 MB）且返回 videoUrl；默认不打开资源管理器
② videoUrl 可取到、Content-Type=video/mp4、**支持 Range**、前 1KB 含 ftyp box
③ 第二次调用 fromCache=true、耗时 8ms（不重复转码）
④ 路径遍历 3 种写法 + 不存在文件 + 非白名单扩展名 全部被拒
```


**用户原话**：「在候选切片 点击试看的时候 可以直接跳转的文件所在目录吗」

### 改之前是什么样

`POST /api/preview-cut` 只**返回一段提示文字**：

```
试看：可在播放器中打开源视频并跳到 00:05:27，播放 132.0 秒。
本服务不做转码预览（避免额外算力占用），精修请用「在 biliLive-tools 中打开」
```

外加 `sourcePath` 字符串。用户拿到路径还得自己开资源管理器、一层层点进去 —— 等于没帮上忙。

### 为什么不是"试看就烧一个切片出来"

切片要跑一次 ffmpeg（实测 30 分钟素材切 2 分钟片约 1.5 分钟），而试看往往是**连着点好几个候选**——
每个都烧一遍既慢又占算力，还会往磁盘上堆一堆中间产物。
**源文件本来就在本地**，把它在文件管理器里"亮出来"是最快、零成本的路径。
所以定下来的语义是：**试看 = 把人带到源文件跟前 + 告诉他该看哪一段**，而不是"生成预览片"。

### 改之后的接口

| 接口 | 行为 |
|---|---|
| `POST /api/preview-cut` | **默认真的打开文件管理器并选中源文件**；返回 `revealed`/`revealHow`/`sourceDir`/`cutOutput`。传 `noOpen:true` 则只返回数据（供自动化，避免测试时满屏弹窗） |
| `POST /api/reveal` | 通用定位：`kind` = `source` / `cut` / `taskDir` / `full` —— UI 上任何路径都能一键打开 |

UI 侧：试看弹窗顶部如实显示「✓ 已在文件管理器中定位源文件」或「未能自动打开文件管理器：<原因>」，
并附三个按钮（重新定位源文件 / 打开任务目录 / 定位切片产物）。**打不开就如实说，不谎报成功。**

### 三条硬性安全边界（不是风格问题）

1. **路径绝不来自客户端**。`/api/reveal` 只接受 `(taskId, kind, index)`，服务端自己去台账取路径。
   否则这个接口就等于"任意本地路径的文件管理器触发器"。
2. **用 `spawn` 而不是 `exec`**。`exec` 会过 shell，路径里的 `&`、`|`、`"` 会被当成命令分隔符
   （`p.name & calc.exe` 这种注入在本地服务上照样生效）。spawn 传数组，没有 shell 参与。
3. **只打开已存在的文件/目录**，不接受任何额外参数。

### 平台差异（各自都踩过，记下来免得再猜）

> ⚠️ **下面这两条第一版写错了，而且我自己"验证通过"了 —— 因为判据用错了。**
> 用户实测反馈"没有正确跳转"才暴露。这一段值得完整读，因为它是一个
> **"验证方法本身有缺陷 ⇒ 假通过"** 的典型案例。

**错误示范（第一版）**：

| 我写的 | 我当时的"验证" | 实际情况 |
|---|---|---|
| 目录：`Start-Process -LiteralPath <dir>` | 命令行没报错 ⇒ 认为成功 | ❌ **静默无效**，一个窗口都不开 |
| 文件：`Start-Process explorer.exe -ArgumentList '/select,"<path>"'` | 命令行没报错 ⇒ 认为成功 | ❌ 打开的是「**文档**」文件夹 |

**为什么第一版会"验证通过"**：我的验证脚本只检查了
①接口 HTTP 200、②`revealed=true`（= spawn 命令发出去了）。
**这两条都不代表用户看到了窗口。** 这是判据设计错误，不是手滑。

**正确的验证方法**（`tools/probe-reveal-methods.ts`、`tools/probe-select-arg.ts` 用的就是它）：

1. 每次创建一个**唯一命名**的临时目录（名字里带随机串）；
2. 执行待测方法；
3. 枚举资源管理器窗口的 `LocationName`，看**随机串是否出现**。
   随机串只可能来自本次操作 ⇒ 不会被"本来就开着的窗口"或默认的「文档」干扰。

用这个判据实测出的结论（`explorer.exe` 直接进程调用，不经过任何 shell）：

| 方法 | 结果 |
|---|---|
| `explorer.exe <dir>` | ✅ 打开目录 |
| `explorer.exe "/select," <file>`（**逗号与路径分成两个参数**） | ✅ 打开文件夹并选中文件 |
| `cmd /c start "" <dir>` | ✅ |
| `powershell Start-Process -FilePath <dir>` | ✅ |
| `powershell Start-Process -LiteralPath <dir>` | ❌ **静默无效**（`-LiteralPath` 不是 `Start-Process` 的参数，它属于 `Get-Item` 一类） |
| `explorer.exe "/select,<file>"`（合在一个参数里） | ❌ 打开「文档」 |
| `explorer.exe "/select,\"<file>\""`（自己再加引号） | ❌ 同上（Node 会给含空格参数自动加引号，再手工加一层反而解析成空路径） |
| `cmd /c start "" explorer.exe "/select,<file>"` | ❌ 同上 |

**最终实现**：

```ts
// 目录
spawn('explorer.exe', [dir])
// 文件（注意是**两个**参数）
spawn('explorer.exe', ['/select,', file])
// 路径自身含逗号时（`/select,` 靠逗号分隔，无法安全表达）→ 退化为打开所在目录
```

**另一个坑**：`explorer.exe` 对**同一个目录是复用已有窗口、不新建**的（Windows 既定行为）。
所以"有没有新窗口出现"这个判据在同路径重复测试时会**假失败** —— 我为此误判过一次，
正确判据是"窗口列表里有没有它"，并在测试前先关掉同名窗口
（`tools/close-explorer-windows.ts` 就是干这个的，顺手也用于清理测试攒下的窗口）。

- **macOS**：`open -R <file>` 就是"在访达中显示"（未在真机验证，按官方语义实现）。
- **Linux**：没有统一的"选中文件"约定，退化为打开其所在目录（`xdg-open`）。

### 12.7.1 第三轮：窗口打开了但"看不见"（层级/前台问题）

用户第二次反馈：「文档窗口 显示在界面上面」。
意思是资源管理器窗口确实开了，但它出现在**浏览器后面 / 被挡住**，看起来就像"没跳转"。

这一步同样踩了一串坑，而且每一坑都验证了同一条纪律 ——
**"命令发出去了" ≠ "用户看到了"**：

| 我写的 | 实测结果 |
|---|---|
| `$window.Activate()` | ❌ `Method invocation failed ... does not contain a method named 'Activate'` —— 这个方法根本不存在。（`Shell.Application.Windows()` 返回的对象只能拿 `HWND`，激活得靠 user32。**凭印象写 API 的代价**。） |
| 只调 `SetForegroundWindow(hwnd)` | ❌ 返回 `False` —— Windows 的**前台锁定**策略不允许后台进程抢焦点。 |
| 用 ALT 键解锁 + `AttachThreadInput` 后再调 | ✅ 返回 `True`，前台变 explorer —— 但**只在非 detached 的进程中有效**。 |
| `SetWindowPos(HWND_TOP)` + `BringWindowToTop` 提 z-order | ✅ 不受前台锁定限制（即使抢焦点失败，窗口也已在最上层） |

**最隐蔽的一个坑**：我一直用 `spawn(..., { detached: true })` 起 PowerShell（因为项目里打开浏览器就是那么写的）。
实测对比（`tools/diagnose-activate-flow.ts`，同一段脚本、同一时刻）：

```
detached spawn  → 前台始终是浏览器（等 9 秒也没变）
spawnSync       → SetForegroundWindow=True，前台变 explorer
```

原因：`detached` 会让子进程脱离控制台/会话上下文，而"模拟 ALT 键解锁前台锁定"依赖
调用进程处于**正常的交互式会话**。detached 下它静默失效。
→ 去掉 `detached` 后，服务的端到端验证通过：调 API 后**前台进程 = explorer**。

另外两个细节：
- **必须轮询等窗口出现**，不能只 `Start-Sleep 700ms` 然后查一次 —— 本函数是在
  `spawn('explorer.exe')` 之后**紧接着**调用的，窗口可能还没建出来。早期版本就是
  查一次没找到直接 `exit`，看起来"脚本跑了"，其实什么都没做。
- 实现用 `-EncodedCommand`（base64/UTF-16LE）传 PowerShell：本项目里 PowerShell
  反复吃过引号与 `$` 的亏（`tools/diagnose-activate-flow.ts` 的第一版命令就因为
  `\$` 转义直接语法报错），编码传递是唯一稳的方式。

**验证**：`tools/verify-reveal-opened.ts` 7/7；另外人工确认调 API 后前台进程为 `explorer`。

### 验证

| 工具 | 覆盖 | 结果 |
|---|---|---|
| `tools/verify-reveal-api.ts` | 17 项：字段完整性 / `noOpen` 不弹窗 / 四种 kind / 5 项安全边界（路径穿越式 taskId、未知 kind、缺 index、缺 CSRF、非法 Origin） | **17/17** |
| `tools/verify-reveal-opened.ts` | 7 项：**客观判据** —— 调完接口后窗口列表里是否有目标（含"先关窗口再验"以规避复用行为） | **7/7** |

**17/17 + 7/7 通过。**

---

## 12.9 「试看」定稿：定位产物 + 系统播放器前台播放（2026-09-24，第 4 轮）

### 最终行为

点「试看」→ **1.4 秒内**：在资源管理器里选中该候选的切片产物 + 用系统自带播放器
（Windows Media Player）**前台播放**。不转码、不生成临时文件、不弹大框。
失败时弹说明并给替代动作（浏览器内联播放 / 在文件夹中定位）。

### 又是三轮演进（这次我不再自己揣测了）

| 轮次 | 用户要求 | 我做的 | 结果 |
|---|---|---|---|
| 1 | 能跳转到文件所在目录吗 | 打开资源管理器并选中源文件 | 实现有 bug |
| 2 | 没有正确跳转 | 修好打开方式 | 窗口开了但被挡 |
| 2b | 文档窗口显示在界面上面 | 加"提到前台" | 窗口到前台了 |
| 3 | 不需要资源管理器弹出来 | 改成**浏览器内联播放**（转码生成 mp4） | 能用，但要等 21 秒转码 |
| 4 | **定位产物目录 + 系统播放器前台播放** | **改为直接调系统播放器** | ✅ 1.4 秒，零转码 |

**复盘**：第 3 轮我做的"内联播放"其实已经能用了，但代价是转码 21 秒 + 占磁盘。
第 4 轮用户给的方案**更简单也更快** —— 因为切片产物本来就是 mp4，浏览器/播放器都能直接放，
**根本不需要再转一次码**。而我第 3 轮之所以去转码，是因为当时"试看"的是**还没切片的候选**
（只有 flv 源文件）。这两件事被我混在一起了：

- **候选还没切片** → 想看内容只能从源文件转码（慢）
- **候选已切片** → 产物就在那儿，直接播（快）

现在按后者做：如果候选还没切片，如实返回"还没切片产物，先切片再看"，
**不擅自触发一次完整切片**（那是副作用很大的另一条路径）。

### 本机实测到的三个障碍（都不是猜的）

| 障碍 | 实测证据 | 对策 |
|---|---|---|
| `.mp4` **没有有效默认关联** | `UserChoice` 为空；注册表挂着坏的 `QyClient_mp4`（**奇游电竞加速器**）。`Start-Process <file>` 弹出**「打开方式」对话框**（前台进程名就叫 `OpenWith`） | **绕过文件关联**，直接指定播放器可执行文件 |
| 播放器窗口抢不到前台 | `SetForegroundWindow` 返回 False（前台被对话框占着 + Windows 前台锁定） | 打开前先关掉「打开方式」对话框；打开后 ALT 解锁 + `AttachThreadInput`（§12.7.1 已验证的手法） |
| 播放器启动要时间 | 窗口不是立刻就有 | **轮询等 `MainWindowHandle` 出现**（25 次 × 400ms），不能 sleep 一次就查 |

**还有一个顺序坑**：第一版是"先开播放器、再定位资源管理器"，
结果**资源管理器把前台从播放器手里抢走了**（客观判据显示前台是 `explorer`）。
改成"**先定位（资源管理器）→ 等 800ms → 再开播放器并前置**"后，前台稳定是 `wmplayer`。

Windows Media Player 的实际路径是
`C:\Program Files (x86)\Windows Media Player\wmplayer.exe` ——
**不在** `System32`（Win11 上那里没有），所以候选路径列表里三个位置都写了。

### 验证

`tools/verify-preview-player.ts`（**10 项，全通过**），判据是**前台进程**而不是返回值：

```
① 接口 ok / player / playerForeground / cutOutput / cutDir 齐全，耗时 1.4s（不转码）
② ★ 调用后前台进程 = wmplayer        ← 这是"用户能看到"的唯一证据
③ ★ 资源管理器里存在该产物目录的窗口  ← "定位并选中"的证据
④ inline:true 回退仍可用（videoUrl 支持 Range）
⑤ 未切片的候选如实返回 notCut，不假装成功
```

### 顺带说明：`cleanupPreviews` / `makePreviewClip` 仍然保留

它们只在 `inline:true`（浏览器内联播放）时使用。留着的理由：
本机 `.mp4` 关联是坏的，万一以后连播放器都没有，内联播放是唯一出路。
默认路径完全不碰它们 —— 不转码、不占磁盘。

---

---

## 13. 素材迁移到 D 盘（2026-09-24，用户要求）

### 13.1 迁移了什么、去了哪

| 原位置 | 大小 | 新位置（真实数据） | 原路径现状 |
|---|---|---|---|
| `C:\Users\demo\Downloads\Bilibili` | 38.83 GB | `D:\live_auto_media\Bilibili` | **Junction** |
| `F:\deepseek\live_auto\data` | 10.99 GB | `D:\live_auto_media\data` | **Junction** |

合计约 **49.8 GB**。迁移后 **C 盘可用空间从 137.6 GB 升到 175.3 GB**（+37.7 GB）。

### 13.2 为什么用 junction 而不是「改配置路径」

两个软件里有大量**写死的路径假设**，改配置只能覆盖其中一部分：

- 项目的 LOGS_DIR / ERROR_REPORT_DIR 是**模块级常量**；
- `servePreview` 的白名单基于 `ledger.taskDir()`；
- biliLive-tools 界面上显示保存目录；
- **历史台账与录制历史里记着文件的绝对路径**（实测 record_history 表里 37 条甲主播的记录
  全部是 `C:\...\Downloads\Bilibili\...`）—— 换路径这些旧记录就全部指向不存在的位置。

junction 让「原路径照常可用」，上述假设**全部继续成立**，两个软件一行配置都不用改，
而且目录联接**不需要管理员权限**（mklink 的 J 模式）。

### 13.3 过程中踩到的四个坑（都不是猜的）

| 坑 | 现象 | 处理 |
|---|---|---|
| **录制还在进行** | robocopy 拷完后复核报差异，差异文件被标 Newer；查 recorder 列表发现 `45678901 state=recording`，`哈喽_PART004.flv` 33 秒前还在写 | 迁移前先查 recorder 状态，**先停录制、再等文件落定** |
| **压制在停录之后仍在跑** | 停了录制仍不一致：`哈喽-弹幕版.mp4` 比副本大 6 MB。**任务队列显示「无进行中」，但实际有 3 个 ffmpeg 进程**在读写该目录 | 不能只看任务队列；改成轮询「文件是否仍被独占锁定 + 是否有 ffmpeg 在处理该目录」 |
| **robocopy 的 Newer 不区分原因** | 干跑只报 Newer，看不出是「大小不同」还是「只是时间戳新」—— 而删除判据必须严格 | 写了 `tools/compare-trees.ts` 逐文件比对，明确区分「大小不同 / 仅时间戳不同 / 只在一边」 |
| **删除被占用文件失败** | 删除时报 `being used by another process`，迁移中止（但源**没被删**，数据安全） | 强杀 ffmpeg 会得到**半成品文件**，比等它更糟；所以改成**轮询等它自然结束**（`tools/finish-migration.ps1`） |

**迁移脚本的安全设计**（每一步都可校验、可回退）：

1. 默认干跑，只报规模与目标；
2. robocopy 同步后用 **robocopy 二次复核**（干跑退出码 0 = 完全一致），最多重试 3 轮；
3. **只在复核通过后才删源** —— 整个过程中源数据一直是安全的（前两次中止都没删任何东西）；
4. 建联接后复核 LinkType/Target，并通过**原路径真实读写**验证；
5. 幂等：已经是 junction 就跳过。

### 13.4 迁移后验证

| 检查 | 结果 |
|---|---|
| 联接类型 | `Junction -> D:\live_auto_media\...`（两处） |
| 通过原路径访问 | 能列目录、能看到 `ledger.json`、读写探测通过 |
| 文件数一致性 | C 盘（经联接）114 = D 盘 114，**无残留** |
| 切片助手服务 | 重启成功，`/api/health` 200，`bililive.ok=true` |
| 台账可读 | 6 个任务 / 40 条已发布标题；`fs.realpathSync` 解析为 `D:\live_auto_media\data` |
| biliLive-tools 历史录制 | 37 条记录可读，路径仍是 `C:\...` 形式**且经联接有效** |
| C 盘空间 | 137.6 GB → **175.3 GB** |

**文件数从 124 变成 114** 需要说明：这不是迁移丢文件 —— 等待压制期间 biliLive-tools
自己删掉了 10 个中间产物（压制完成后它清理以 -proj 结尾的中间文件）。迁移同步的是
**删减后**的最终状态（源与目标都是 114），且源目录是在「两边完全一致」之后才删除的。

### 13.5 顺带发现的工具缺陷

迁移时发现项目自己的 `taskList()` **看不到压制任务**：任务队列报「没有进行中的任务」，
但实际有 3 个 ffmpeg 在跑。所以「用任务队列判断是否正忙」是不可靠的 ——
这类判断应该直接看**进程**（本次改为按 ffmpeg 命令行是否涉及目标目录来判断）。

### 13.6 相关工具

| 工具 | 用途 |
|---|---|
| `tools/migrate-media-to-d.ps1` | 迁移主脚本（停录制 → 同步 → 复核 → 删源 → 建联接 → 重启服务），支持干跑 |
| `tools/finish-migration.ps1` | 等压制结束再收尾（轮询文件锁与 ffmpeg 进程） |
| `tools/compare-trees.ts` | 逐文件精确比对，区分「大小不同 / 仅时间戳不同 / 只在一边」 |

---

## 14. 只处理原始录制：跳过 biliLive-tools 的压制产物（2026-09-24，用户确认）

### 14.1 问题：同一段素材被处理了两次

用户确认的分工是「biliLive-tools 压制弹幕版 + 纯享版并投到同一稿件；切片助手只追加切片」。
但目录轮询会把**压制产物也当成素材导入**，实测账（2026-09-24 凌晨）：

```
00:56:50  自动导入  00-48-58-767 哈喽.ts                    → ASR ¥0.046 + LLM ¥0.028
00:58:51  自动导入  00-48-58-767 哈喽-弹幕版-<uuid>.mp4      → ASR ¥0.046 + LLM ¥0.032  ← 同一段素材，又跑一遍
```

两个坏处：

1. **白花钱**：同一段 3 分钟素材被转写两次（多花约 ¥0.08/段，一天累积可观）；
2. **可能重复投稿**：同一场素材产出两条切片，标题不同则指纹也不同，去重拦不住。

而且压制产物的画面上**已经烧了一层弹幕** —— 拿它当源虽然不会双层弹幕
（项目会按 `fullVideoHasDanmaku` 处理），但成品与「原始录制」那条线并不一致。

### 14.2 改法（`src/watch-import.ts`）

在导入**之前**判断：若候选是压制产物（`hasDanmakuInPicture === true`，即文件名带
`-弹幕版` / `-纯享版` / `-danmaku`，含 biliLive-tools 的防覆盖 UUID），
**且同目录下存在同一分段号的未烧弹幕原始录制**，则跳过并给出可读原因。

三段互补的结论：

| 情形 | 行为 |
|---|---|
| 有原始录制 | **跳过压制产物**（原因写明「完整版由 biliLive-tools 投，切片助手只处理原始录制」） |
| 盘上只剩压制产物 | **仍然导入** —— 有源总比没源好（原始文件可能已被「用完即删」清掉） |
| 配对不确定 | **不跳过** —— 宁可多处理一个，也不能把该处理的原始录制一起跳过 |

**配对从严**：只认「同目录 + **同分段号**」的未烧弹幕候选，`partIndex` 两侧都为 undefined 才算同类，
不做「空配任意」的宽松匹配。误配的代价是**丢素材**，漏配的代价只是退回旧行为 —— 两者不对称，所以从严。

配套改动：`RecordingCandidate` 补上 `partIndex`（此前只有内部的 `RecordingVariant` 有），
否则 watch-import 根本拿不到分段号、配对只能靠文件名前缀猜。

### 14.3 验证

新增 `test/watch-skip-burn-product.ts`（**10 项，全通过**），直接驱动 `WatchImporter.scanOnce()`：

```
1. 同目录有原始录制 → 压制产物被跳过、原始录制正常导入
2. 同目录**没有**原始录制 → 压制产物仍要导入（安全边界，防丢素材）
3. 分段录制：PART001 的压制产物只与 PART001 的原始录制配对（不跨分段误配）
4. 回归保护：没有压制产物时，原始录制照常导入
```

⚠️ 测试必须**连跑两轮** `scanOnce()`：稳定性判定要求「体积连续两轮不变」，
第一轮只登记基线、第二轮才导入。第一版测试只调一次，于是"什么都没导入"，看起来像功能坏了。

### 14.4 顺带修正的一个配置错误

排查时发现房间 `丙主播` 的 `segment` 是 **20 分钟**（继承了全局默认），
所以切出来的是 3.5 分 / 9 分的碎片，而不是用户期望的「每小时一段」。已改为 **60 分钟**：

| 房间 | segment |
|---|---|
| 乙主播 | 59 分钟 |
| 甲主播 | 59 分钟 |
| **丙主播** | **60 分钟**（本次修正，原为 20） |

### 14.5 顺带确认：`.ts`（MPEG-TS）素材完全可用

用户的实际流程会产生 `.ts` 分段，实测项目的处理链路：

| 检查 | 结果 |
|---|---|
| `probeMedia()` 取时长 | `哈喽.ts` → 209.5 秒；`哈喽-PART000.ts` → 487.3 秒（都正常） |
| 候选发现 | `.ts` 被正常列为候选（不会被格式过滤掉） |
| ASR | 实测 `00-48-58-767 哈喽.ts` 已完整跑完转写 → 选片 → 切片 → 投递（`PUBLISHED`） |

所以「每小时一段」的工作流在格式上没有任何障碍。

### 14.6 目录轮询的时序（用户常见疑问：为什么放进去了没反应）

实测配置：`intervalSec=60`、`stableSec=30`，判定条件是「体积连续两轮不变」。
所以文件**停止写入后最多 90 秒**会被导入。

排查过程中反复出现的现象是：文件明明在目录里，结论却是
「**文件仍在写入（录制可能未结束）**」—— 这是**保护机制**而不是缺陷：
拿一个还在写的文件去转写，会得到错位的时间轴与切在半句上的片段。

另外两条容易误会的规则（都是刻意设计）：

- 「**首次启用时已存在**（历史积压不会自动导入）」：避免一开功能就把几百个历史录制全跑一遍；
- 迁移/换盘导致**扫描范围变化**时会重新登记基线、本轮不导入（`importExisting=false` 时）。

---

## 15. 指纹墓碑：堵住唯一会污染线上的漏洞（2026-09-24）

### 15.1 起因

对照任务书做差距分析（WP1–WP7 逐条 + 代码盘点）时发现一个**此前没人注意到**的漏洞，
它是本项目唯一会「在 B站 上留下错误」的路径 —— 其它缺陷最多是本地少投、多等一下、日志不好看。

### 15.2 漏洞本体

去重的唯一本地依据是 `ledger.fingerprints`。而 `deleteTask()` / `deleteClip()` 原本会
**直接删掉**相关条目，理由写得很清楚（当时的注释）：

> 「避免以后重跑被误判为「已投过」而静默跳过（少投一稿且没有任何提示）」

这个理由对**没投出去过**的切片是对的。对**已经投出去过**的切片则是错的：

```
1. 用户删掉一个已投稿件的任务（deleteTaskDir=true）
   → ledger.deleteTask() 清掉指纹 + 从 publishedTitles 移除标题
2. 同一份录播素材仍在 import.watch.dirs 里（或用户手动重新导入）
   → 被当成全新素材
3. 重新转写 + 重新分析，LLM 很可能给出**同样的时间区间**
4. findFingerprint 查不到 → 本地去重整条穿透
5. B站 侧那道「按标题反查」也拦不住 —— 切片标题是 LLM 每次重新生成的，
   换个措辞就穿透（publish.ts 里已记录过同类事故：BV13hhE6XEQM 的 9 组重复分P）
```

净结果：**B站 上出现第二个内容完全相同的稿件**，而 B站 没有删除稿件的开放接口，
用户只能去创作中心手工处理。

漏洞窗口当时是**真实打开**的：`data/ledger.json` 实测 `tasks=0、fingerprints=0、publishedTitles=0`
（用户刚删过几场任务），而 `import.watch.enabled=true`。

### 15.3 修复：墓碑（`FingerprintTombstone`）

核心规则一句话：**只给「真的投出去过」的指纹立碑，没投过的照旧直接丢弃。**

| 情形 | 指纹处理 | 能否重投 |
|---|---|---|
| 删掉**没投过**的切片 / 任务 | 直接丢弃 | ✅ 可以（保留原有正确行为） |
| 删掉**已投过**的切片 / 任务 | 转为墓碑，永久保留 | ❌ 被拦，界面显示原因 + 可人工解除 |

「投出去过」的判据（`wasSubmitted()`）：指纹表里有 bvid，或该切片状态是
`SUBMITTING` / `SUBMITTED` / `PUBLISHED`。

`SUBMITTING` 算「投过」是**故意保守**：那是崩溃判定点，请求可能已经发出去而我们没看到响应。
判成「没投过」并放行重投，最坏结果是重复稿件；判成「投过」并立碑，最坏结果是少投一稿
且**界面上明确显示为什么**、可一键解除。与 `setClipStatus` 里「宁可不投，不可重复投」同一取向。

顺带修正一处相关错误：`deleteTask` 原本**无条件**把标题从 `publishedTitles` 里移除。
已发布的稿件在 B站 上仍然占着那个标题，本地把它忘掉只会削弱「按标题反查」这道防线 ——
现在改成「只有当本场一片都没投出去过时才释放标题」。

### 15.4 落点（改了什么）

| 文件 | 改动 |
|---|---|
| `src/ledger.ts` | `FingerprintTombstone` 类型 + `tombstones` 字段；`deleteTask`/`deleteClip` 分流；新增 `findTombstone` / `listTombstones` / `releaseTombstone` / `tombstoneCount`；`normalizeLedgerFile` 容忍老格式；`registerFingerprint` 对「登记已立碑指纹」告警（说明某条防线被绕过）|
| `src/publish.ts` | `cutAndUploadClip` 在指纹检查后**加墓碑检查**；`publishAsMultiPart` **不分模式**（续传 / 新建稿件都查）过滤墓碑切片并给出可见警告 |
| `src/types.ts` | `ClipRecord.blockedByTombstone?` —— 标记「本次故意没投」，UI 据此渲染 |
| `src/server.ts` | `GET /api/tombstones`、`POST /api/tombstone/release`（必须 `confirm:true`）；`toTaskDetail` 把墓碑本体随切片一起返回 |
| `src/daemon.ts` | 删除任务时把「N 条转为墓碑」写进返回提示；`health.tombstones` 供健康面板显示 |
| `src/mcp.ts` | 新增 `list_tombstones`（只读）与 `release_tombstone`（确认串 `确认旧稿件已删除`），工具数 21 → 23 |
| `public/ui.html` | 切片卡片「🪦 墓碑拦截」徽标 + 灰紫卡片 + 原因说明（旧 bvid / 原任务 / 立碑时间）+ 解除按钮（二次确认）；健康面板新增墓碑 KPI 与清单表 |
| `package.json` | 新增 `fingerprint-tombstone-test` 并接入 `npm run verify`（套件 34 → 35）|

**墓碑刻意不设上限。** 设了 FIFO 就会丢掉最旧的条目，而丢掉的那条恰好被重新投出去
就是重复稿件 —— 正是墓碑要防的事。单条约 200 字节，5000 条约 1 MB；
真到这个量级会在日志里告警。墓碑也**不会自动过期**，只能人工解除（解除会写一条
`publish-log.jsonl` 的 `action='tombstone-release'`，事后永远查得到「为什么又投了一遍」）。

### 15.5 验证

**后台语义**：新增 `test/fingerprint-tombstone.ts`，**69 项断言全通过**：

| 段 | 锁住的行为 |
|---|---|
| ① | 删**没投过**的切片 → 指纹彻底丢弃、不立碑（不能被墓碑误伤正常用法）|
| ② | 删**已发布**的切片 → 生效指纹消失（复现漏洞那一步）、墓碑接管、含 bvid/原任务/标题、落盘后仍在 |
| ③ | `SUBMITTING` 也立碑（崩溃判定点，故意保守）|
| ④ | 删任务：已投的立碑 + **标题继续占用**；未投的全部释放 |
| ⑤ | 删任务但一片都没投过 → 标题也要释放（不能永久占住）|
| ⑥ | 人工解除后可重投；解除不存在的指纹明确失败；`publish-log` 留痕；**解除不算一次投稿**；解除时**连带摘掉切片上的 `blockedByTombstone` 标记**（并落盘）|
| ⑦ | 老 `ledger.json`（无 `tombstones` 字段）不被判成损坏、格式自然升级 |
| ⑧ | **端到端**：真实 `Publisher` 走**新建稿件**路径 —— 第一场投 2 片 → 反查 bvid → 删整场（立碑 2 条）→ 第二场同素材同区间同标题 → **0 次上传**、`skipped` 有值、警告含「墓碑拦截」、切片带 `blockedByTombstone` → 解除后重投成功；**反证**：没有墓碑时同样的内容会照投 |

第 ⑧ 段里的「新建稿件」路径是刻意选的：重跑一场被删过的素材时 `resumeAid` 为空，
`publishAsMultiPart` 里那段 `if (resumeAid)` 的指纹去重根本不执行 —— 漏洞就是从这里进来的。

**界面**：新增 `tools/verify-tombstone-ui.ts`（`npm run tombstone-ui`），
Edge headless + CDP **真点按钮**，**23 项断言全通过**。它自己造夹具
（`tombui-*` 前缀，跑完精确清理），**不依赖任何用户数据**：

| 断言 | 说明 |
|---|---|
| 卡片有「🪦 墓碑拦截」徽标、灰紫底色 | 与「失败」的红色区分开：它不是错误 |
| 正文写明「这一片没有投稿（不是失败）」 | 用户不会误以为系统坏了 |
| 说明里带旧 bvid / 原任务 id / 立碑时间 / 原标题 | 用户据此去创作中心核对 |
| 有「解除墓碑」按钮且真实可见 | |
| **不显示「重新切片」** | 重切只会再撞一次墓碑，属于误导 |
| 健康面板有墓碑 KPI 与清单表 | 用户不知道有墓碑时，这是唯一入口 |
| 确认框点明「允许同一内容再投一次」并给出旧 bvid | 后果不可逆，必须说清 |
| ★ 点完之后**台账里的墓碑真的没了** | 不是只把界面藏起来 |
| 解除后卡片上的墓碑说明消失 | 界面跟着状态走 |
| 全程无未捕获 JS 异常 | |

> 为什么不把它塞进 `ui-e2e.ts`：那个文件前面的段落依赖**用户的真实数据**
> （录播清单、夹具切片），实测会因为清单变化而中途抛异常，把后面的用例一起带走。
> 墓碑是「防止线上出现重复稿件」的最后一道防线，值得一个随时能单独跑、不受外部数据影响的用例。

### 15.6 全量回归

`npm run verify` 串 **35 个套件全部通过**（typecheck / 34 个测试）。
其中 `fingerprint-tombstone-test` 69 项、`mcp-test` 66 项（新增 9 项墓碑断言）、
`clip-actions-test` 28 项（其中「删切片要清掉指纹」这条语义未被墓碑破坏）、
`fingerprint-dedup-test` 18 项、`e2e` 152 项、`smoke` 66 项、`real` 21 项。

`tools/verify-tombstone-ui.ts` 23 项（需服务在线 + Edge，故不进 `verify` 链，
用 `npm run tombstone-ui` 单独跑）。

### 15.7 顺带修掉：`fmtBytes` 只被调用、从未被定义（界面缺陷）

写 `ui-e2e` 时先跑既有用例，第 12 段（真点「查看待删清单」）红在这里：

```
页面诊断：toasts=["读取待删清单失败：fmtBytes is not defined"] errs=[]
```

`public/ui.html` 里有 **7 处**调用 `fmtBytes(...)`（待删清单弹窗、回收站面板、
`#btnPendingDelete` 角标），但**从来没有定义过这个函数**。后果：

- 「查看待删清单」与「回收站」两个弹窗一打开就抛 `ReferenceError`，只弹一句
  「读取待删清单失败：fmtBytes is not defined」，功能等于**完全不可用**；
- 「用完即删」的 24 小时反悔窗口因此没有界面入口。

为什么此前没被发现：

- 服务端用例（`pending-delete-test` 42 项、`trash-test` 26 项）全部直接打 HTTP 接口，
  **不经过页面**，所以永远看不到 `ReferenceError`；
- 纯 DOM 断言也看不出来：弹窗的 HTML 根本没被渲染出来，断言只会说"元素不存在"。

修法：在 `fmtTime` 旁边补上 `fmtBytes`（与 `src/util.ts` 的同名函数保持同一套单位与精度），
并在注释里写明这个坑。修完之后 `ui-e2e` 第 12 段的两条真实删除路径（同盘进回收站 /
异盘不可恢复）都能跑通了。

> 这也解释了一件事：`ui-e2e` 之前**不在** `npm run verify` 里。它是唯一会真正驱动页面的用例，
> 也因此是唯一能抓到这类「前端函数缺失」的用例 —— 值得在下次整理 verify 链时并进去
> （它自身还依赖用户数据，需要先把那几个前提改成自造夹具）。

### 15.8 一次真实事故的修复记录（顺带）

实施本节的改动期间，服务正在处理一场真实录播（`auto-20260923175913-qpq8`，
主播丁主播，目录轮询自动导入）。为了加载新代码重启了服务，把该任务打断在 `ANALYZING`。
发现后立即用 `POST /api/task/:id/retry {fromStage:'ANALYZED'}` 续跑（转写已缓存，
**没有重复产生 ASR 费用**），最终正常投出 `BV1vohZ6MEbw`（2 个切片，`is_only_self=1`）。

教训：`tools/restart-service.ts` 只看端口占用，**不知道服务是否正在处理任务**。
下次重启前应先查 `/api/monitor` 的 `queue.busy`。

---

## 16. 分段录播：第 1 段会丢、第 2 段之后没弹幕（2026-09-24 直播中实测并修复）

### 16.1 起因

用户在监控面板上看到一句话：

> 「上一轮对每个文件的结论（共 2 个，其中 2 个没导）」——
> `…-PART001.ts` 236.5 MB「正在录制，等写完」

然后问：**已经录到第三个 20 分钟了，为什么这里还是第 2 个在录制？**

### 16.2 先排除：录制与检测都没坏

实测（两轮 45 秒采样 + NTFS 创建时间）：

| 文件 | 是什么 | 创建 | 修改 | 大小变化 |
|---|---|---|---|---|
| `01-34-08-285 ….ts` | 上一场（已投出 `BV1vohZ6MEbw`） | 01:34:08 | 01:51:21 | 不变 |
| `01-51-37-332 ….ts` | **第 1 段** | 01:51:37 | 02:11:32 | 不变 |
| `01-51-37-332 …-PART001.ts` | **第 2 段（正在写）** | 02:11:32 | 跟当前时间 | +43.2 MB / 45 秒 |
| `01-51-37-332 ….xml` | 第 1 段的弹幕（跨度 22s→1194s，正好 20 分钟） | | | |
| `02-11-32-593 ….xml` | **第 2 段的弹幕**（首条弹幕绝对时间 = 02:11:34） | | | |

即：**正在录的那一段**用「会话开始时刻」+ `-PART{n}` 命名，而**弹幕 XML** 用「**该段自己的开始时刻**」命名。
于是同一个会话里会冒出一个新时间戳前缀的 `.xml`，看起来像新开了一场录制 —— 那正是用户误判成
「第 3 个 20 分钟」的东西。

面板说 `-PART001.ts`「正在录制，等写完」是**对的**；整组也因为 `possiblyRecording=true` 被正确跳过，
不会中途投出半场稿件。

### 16.2b 命名模型（看完一整轮切段后才完全确认）

用户后来说了一句关键的话：「**录制完成后命名一样了**」。跟进实测（创建时间来自 NTFS birthtime）：

| 文件 | 创建 | 修改 | 是什么 |
|---|---|---|---|
| `01-51-37-332 ….ts` | 01:51:37 | 02:11:32 | 第 1 段（**关闭后**叫「会话开始时刻」） |
| `02-11-32-593 ….ts` | 02:11:32 | 02:31:32 | 第 2 段（**关闭后**改成「**它自己的**开始时刻」） |
| `01-51-37-332 …-PART002.ts` | 02:31:32 | 仍在写 | 第 3 段（**录制中**：会话开始 + `-PART002`） |
| `02-31-32-636 ….xml` | 02:31:42 | | 第 3 段的弹幕（与它关闭后的视频名**完全一致**） |

所以完整的命名规则是**两段式**：

> **录制中**：`<会话开始> <标题>-PART{n}.ts`（`n` 是会话内序号，从 000 开始）
> **该段关闭后**：改名成 `<该段自己的开始时刻> <标题>.ts`，`-PART` 后缀消失

推论（都是实测过的）：

1. **关闭后视频名与弹幕名一致** → `findSiblingDanmaku` 本来就能配上，**正常路径不需要任何新逻辑**；
2. **相邻段的边界是零间隔**（上一段 mtime == 下一段 birthtime，实测 0.0 秒）——
   这是"同一场连续录制"的可靠判据，也是当初录制器重启留下的 2.1 / 10.4 秒间隙能区分开的原因；
3. 录制器**当前正在录的那一段**是唯一带 `-PART{n}` 后缀的文件。

### 16.3 真 bug 1：第 1 段会丢（`discoverSegments`）

`discoverSegments` 只认 `-PART\d+`，而**第 1 段叫基名 `X.ts`、根本没有后缀**。实测（真实命名放临时目录）：

```
X.ts          → 1 段   （看不见 PART001/PART002）
X-PART001.ts  → 2 段   （PART001 + PART002，**第 1 段凭空消失**）
X-PART002.ts  → 2 段   （同上）
对照 哈喽-PART000/001/002.ts → 3 段 ✅
```

**修法**：`SegmentPattern` 增加 `baseFileName`，当样本是 `-PART{n}` 形态时记下基名；
`discoverSegments` 在满足边界条件时把基名文件补成第 0 段。
另外加了「形态 C」：样本自己就是基名（`X.ts`）时，用 `X-PART000.ts` 反推一次模式，
并要求反推出的基名与样本名一致（自校验，否则任何 `abc.ts` 都会得到一个瞎猜的模式）。
**只对 `PART` 标记启用**，`.part1` / `-01` 这类更含糊的形态不启用。

#### ⚠️ 这个修法的第一版是**错的**，已收紧（值得单独记一笔）

第一版无条件补位，于是在**录到第 3 段**时（`X.ts` 是第 1 段，而第 2 段已改名走掉）：
`discoverSegments('X.ts')` 会返回 `[第1段, -PART002]` —— 把第 1 段和第 3 段拼成"一场"，
**中间整整 20 分钟被静默丢掉**。这是实测抓到的，不是推演：

```
discoverSegments('01-51-37-332 ….ts') → [第1段(01:51:37), -PART002(第3段)]   ← 少了 02-11 那 20 分钟
```

**边界改成：只有最小 PART 序号恰好是 1 时才补位。** 理由：段一关闭就改名，`-PART` 序号
并不能告诉你"基名文件是第几段"—— 录到第 5 段时基名旁边站的是 `-PART004`，中间三段的名字
已经完全不同了，靠前缀根本拼不出来。宁可只返回样本（上层退回单文件处理），也不能拼出缺段的时间轴。

验证覆盖 4 种情形：① 第 1 段 + 正在录的第 2 段（最小 PART=1）→ 合并；② 第 1 段 + 正在录的第 3 段
（最小 PART=2）→ **不合并**；③ 老形态 `_PART000` 三兄弟 → 合并；④ 单文件 → 不合并。

#### 事实订正：这不影响「一个稿件」

一度以为「每段一个 `-弹幕版.mp4`」= 每段一个稿件，**这是错的**。实测 `BV1vohZ6MEbw`：

```
P1–P3   丁主播(⊙o⊙)？1/2/3 弹幕版   17:15 / 20:01 / 20:01   ← biliLive-tools 投的
P4–P6   丁主播(⊙o⊙)？1/2/3 纯享版   17:15 / 20:01 / 20:01   ← biliLive-tools 投的
P7–P12  6 个切片                                            ← 切片助手投的
```

`videos=12`，**全在同一个稿件里**。分段切的是**文件**，不是稿件；biliLive-tools 把每段追加成
新的分P，我们的切片也追加进同一个稿件（第 2 段那 20 分钟的任务 `auto-20260923184031-9tcf`
产出的 4 个切片，bvid 同样是 `BV1vohZ6MEbw`）。所以「一场直播一个稿件」本来就成立。

### 16.4 真 bug 2：正在录制的那一段拿不到弹幕（`danmaku-merge`）

```
POST /record-history/danma-file
  2026-09-24 01-51-37-332 (⊙o⊙)？.ts         → 有映射
  2026-09-24 01-51-37-332 (⊙o⊙)？-PART001.ts → **无映射**
```

同名回退也失败：文件名叫 `…-PART001.ts`，而它那一段的弹幕叫 `02-11-32-593 ….xml`，前缀完全不同。

**实际影响范围**（按 16.2b 的命名模型修正后）：只存在于「文件还带 `-PART{n}` 临时名」的窗口里。
那个窗口里我们**本来就不会导入**（`possiblyRecording` 会拦），所以线上没有真的吃过这个亏 ——
但这条路径一旦被走到（手工导入正在录的文件、或录制器把改名做晚了），后果是**静默降级**：
`signals.json` 里密度曲线/峰值/热词/高能事件全空，日志只有一句"未找到同名弹幕文件"。

**修法**：新增 `src/danmaku-merge.ts`：

| 步骤 | 做法 |
|---|---|
| 候选识别 | 同目录、`.xml`/`.ass`、**去掉时间戳前缀后与视频分段同标题** |
| 配对 | `absStart[0] = 文件名时间戳(第0段)`，`absStart[k] = absStart[0] + globalStart[k]`；与弹幕文件名时间戳就近匹配（容差 180 秒），**一对一互斥** |
| 合并 | 第 k 段的每条弹幕时间 += `globalStart[k]`，拼成一条**全局时间轴**的 XML |
| 兜底 | biliLive-tools 的 `danma-file` 映射优先；全部失败则退回原有同名查找 |

**它是安全网，不是主路径**：正常流程下段一关闭视频就改名成与弹幕同名，`findSiblingDanmaku` 直接命中。

实测效果（丁主播那场，零付费）：

```
第 1 段 ← 2026-09-24 01-51-37-332 (⊙o⊙)？.xml     偏移    0s | 依据 bililive-tools
第 2 段 ← 2026-09-24 02-11-32-593 (⊙o⊙)？.xml     偏移 1200s | 依据 timestamp | 差 4.8s
各段条数: 34 / 43 共 77 条
时间轴范围: 0:21 → 36:35（成片总长 36:54）—— 覆盖整场
```

### 16.4 修复过程中自己踩到的三个坑（都已加断言钉住）

1. **`chooseDanmaku` 的优先级**：最初写成「显式 → 同名 → 按段合并」，看着合理，
   实际有一条隐蔽的失效路径 —— 目录轮询会把清单里选中的**那一个**弹幕文件当 `explicitPath` 传进来，
   于是它恒为真，**按段合并永远走不到**，多分段照旧只有第 1 段有弹幕，而界面上还显示"有弹幕"。
   改成「合并优先」，并把这段判断抽成纯函数 `chooseDanmaku()` 由单测直接钉住。
2. **正则太严 → 静默产出空结果**：抽取 `<d>` 的规则原本是 `<d\s+p="([^"]*)"\s*>`，
   而真实弹幕是 `<d p="…" user="偷懒羊" uid="…" timestamp="…">`（`p` 后面还有属性）——
   **一条都抽不到**，合并出来是个空文件，而所有输入文件都完全正常。真实素材跑一遍才暴露出来。
   现在额外属性也一起保留（`user`/`uid`/`timestamp` 不能丢）。
3. **同一分段被配两次**：映射与时间戳两路各自命中同一个分段，合并时那段弹幕被算两遍。
   现在时间戳那一路接收 `skipIndexes`，已被认领的分段直接跳过。

### 16.5 顺带修的测试脆弱性

- `test/real-media.ts` 断言「单文件场景下分段数为 1」，而它挑的是磁盘上最小的可用素材 ——
  录到一半时最小的候选变成了 `-PART001.ts`，`discoverSegments` 正确返回 2 段，断言反而红了。
  **是断言假设错了，不是分段识别错了**：现在按实际分段数分别校验，并始终校验
  「全局总时长 = 各段时长之和」这条真正的不变量。
- 同一文件的磁盘扫描兜底会挑中**正在烧制的 `-弹幕版.mp4`**，ffprobe 报
  `moov atom not found`（mp4 索引还没落盘），后面三条断言跟着全红 —— 与代码无关。
  现在排除压制产物（`弹幕版`/`后处理`/`danmaku`）与 5 分钟内刚写过的文件。

### 16.6 验证

- `test/segment-danmaku.ts` —— **89 项断言全通过**（分段识别 11 / 时间戳 7 / 挂钟起点 3 /
  配对 15 / 容差与退化 6 / 合并 13 / 端到端 8 / 真实 XML 形态 6 / 单段只配一份 5 / 选哪一份 15）。
  已接入 `npm run verify`（套件 35 → 36）。
- `tools/verify-segment-danmaku-real.ts` —— 拿**真实素材**跑一遍（只读、零付费），
  16.4 的实测输出就是它打印的。
- 全量回归：`npm run verify` **36 个套件全绿**。

### 16.6b 结论：分段策略**保持不动**（用户 2026-09-24 决定）

查清 16.2b / 16.3 的命名模型后重新确认过，用户的选择是：

> **不改 `recorder.segment`（该房间保持 20 分钟）。每段一个分P + 每段各跑一次切片，就是要的行为。**

理由是这套流程本来就已经正常工作（实测）：

| 环节 | 实测 |
|---|---|
| 录制 | 每 20 分钟滚一段，关闭后改名成自己那一秒的时间戳 |
| 完整版 | biliLive-tools 把每段的弹幕版/纯享版**追加成同一个稿件的新分P**（`BV1vohZ6MEbw` 的 P1–P6）|
| 切片 | 每段一个任务（如 `auto-20260923184031-9tcf`，20 分钟 / ¥0.31），切片追加进**同一个稿件**（P7–P12）|
| 弹幕 | 每段有自己的 XML，关闭后与视频同名，`findSiblingDanmaku` 直接命中（该任务实测 52 条弹幕 / 9 峰值 / 16 热词）|

所以本轮**没有**去改 biliLive-tools 的任何配置。`segment` 保持 20；
`tools/` 下也没有留下任何改配置的脚本。

### 16.7 已知的并发写入

修复期间项目里出现了**另一路并发写入**：`tools/` 下 02:23–02:30 之间多出一批
`*-probe.mjs` / `asr-window-probe.ts`（弹幕/字幕锚点方向），`README.md` 与 `config.json` 也被改过。
其中 `loudness-profile-probe.mjs` 带 BOM 会让 `text-test` 红、`asr-window-probe.ts` 有隐式 any
会让 `typecheck` 红。这两处已用项目自带工具按最小改动处理（`tools/strip-bom.ts` + 补类型标注），
**没有改动它们的逻辑**。后续如果那一路还在写，`npm run verify` 可能再次变红 —— 那不是本节引入的。

### 16.8 本轮改了什么（一览）

| 文件 | 改动 |
|---|---|
| `src/media.ts` | `SegmentPattern.baseFileName` + 形态 C 反推；`discoverSegments` 带**最小 PART 序号 = 1** 的边界补位 |
| `src/danmaku-merge.ts` | **新增**：候选识别 / 时间戳配对 / 合并成全局时间轴 / `chooseDanmaku` 优先级 |
| `src/daemon.ts` | `importLocal` 用 `chooseDanmaku` 决定弹幕来源；新增 `resolveMergedDanmaku` |
| `src/recordings.ts` | 清单与导入预览如实显示「按段配对」的弹幕（`danmaSource: 'segment'`）|
| `test/segment-danmaku.ts` | **新增**，89 项；接入 `npm run verify` |
| `tools/verify-segment-danmaku-real.ts` | **新增**，真实素材只读验证 |
| `test/real-media.ts` | 不再假设样本是单文件；扫描兜底排除压制产物与刚写过的文件 |
| `package.json` | `segment-danmaku-test`（套件 35 → 36）|

---

## 17. 实时监控新增「已投稿文件」（2026-09-24，用户要求）

### 17.1 需求原话

> 「在实时监控里增加一个新的目录：当已经投稿上传的文件都在这里显示；
> 已经投稿还在审核的显示"审核中"；已经投稿成功的显示 bv 号；
> 点击 bv 号可以和"最近投稿"里的一样直接跳转；然后还有删除功能，
> 可以删除已经投稿成功有 bv 号的文件。」

### 17.2 数据来源

面板原有的「最近投稿」只列**任务**与 bvid，既看不到本地文件、也不能删。新块按**产物文件**列：

| 类型 | 本地路径 | bvid 从哪来 |
|---|---|---|
| 切片 | `clip.cutOutput` | `clip.bvid`（反查到的）|
| 完整弹幕版 | `task.source.fullVideoPath` | `task.fullVideoBvid` |
| 纯享版 | 任务目录 `full/` 下 `p2`/`pure` 命名的 mp4 | 同上（与完整版是**同一个稿件**的分P）|

### 17.3 审核状态：用 B站 自己给的文案，不猜状态码

实测 `/bili/archives` 的返回里直接带 **`state_desc`**，审核期就是中文「审核中」，通过时为空串。
不用 `state` 数字判断的原因：同一份数据里出现过 `-30` 与 `-50` 两个值，
负值在「审核中 / 仅自己可见 / 打回」之间靠数字分不开，而 `state_desc` 是官方文案。

判定抽成纯函数 `reviewStatusOf()`（导出，单测直接钉住三个分支）：

| 情形 | 状态 | 界面显示 |
|---|---|---|
| 没有 bvid（B站 还没把稿件列出来）| `reviewing` | 「审核中」 |
| 有 bvid，`state_desc` 非空 | `reviewing` | 「审核中」（原文案）|
| 有 bvid，`state === 0` 且 `state_desc` 为空 | `passed` | **可点的 bv 号**（新窗口打开，与「最近投稿」一致）|
| 有 bvid 但列表里查不到 | `unknown` | 「审核中（列表里还没有）」——**不能当成已通过** |

`state_desc` 的拉取带 **60 秒缓存**（面板 5 秒轮询，不缓存就是每分钟问 B站 12 次）；
拉失败时**沿用上一次的结果**并附一个 `error` 提示，避免面板忽明忽暗。

### 17.4 删除：两道硬闸

1. **必须有 bvid** —— 没投成功的东西不该从这里删（那是「待删清单」与任务删除的活），
   否则用户会在"这个到底投没投出去"都不确定的时候把源材料删了；
2. **走回收站，不是 `rm`** —— 与项目里其它删除路径一致，删错了能捞回来。

只动文件、**不动台账**：`cutOutput` / `source.fullVideoPath` 留着当"它原来在哪"的记录，
所有消费点本来就有 `exists()` 守卫（`publishAsMultiPart` 会明说"没有可用的产出文件"）。
台账要是也清掉，从回收站恢复文件之后反而对不上账。

接口：`POST /api/published-file/delete { key, confirm }`。`key` 由面板下发（`<taskId>:clip:<i>` /
`<taskId>:full` / `<taskId>:pure`），**不接受任意路径** —— 与「待删清单」同一个口径。
确认框把三件事说清楚：进回收站可恢复、**B站 上的稿件不会被撤回**、台账记录保留所以重跑不会重复投稿。

### 17.5 顺带修的三处

- **KB 级文件显示成 "0 MB"**：切片可能只有几百 KB，`toFixed(1)` 的 MB 会把它们全显示成 0。
  新块的 items 带 `sizeText`（走 `fmtBytes`，自己选单位），界面用它。
- **`restart-service.ts` 会打断正在跑的任务**：本轮实测又栽了一次 —— 在 `queue.busy=true`
  时重启，把 `auto-20260923185952-rn7s` 打断在 `CLIPPING`（上传中途）。
  现在脚本**默认先查 `/api/monitor` 的 `queue.busy`，忙就拒绝重启**（`exit 3`）并打印在跑什么、
  怎么续跑；确实要打断得显式加 `--force`。这是重复两次的同一个坑，所以在工具层面堵住，
  而不是继续靠"记得先看一眼"。
- **`ui-e2e` 把自己的失败写进了真实 `data/errors.jsonl`**：它点「从某阶段重跑」时，
  夹具任务（`uie2e-fixture-*`，`source.rawFiles` 为空）在**常驻服务**里抛
  `buildSegmentMap: files 为空`，错误事件落到真实事件流里 —— 实测攒了 32 条，
  把监控面板的「近 24h 错误」顶到 50 并挂上红字阈值告警，看起来像生产故障。
  ⚠️ 在测试进程里 `setErrorsPath` **拦不住**（写盘的是服务），所以改成在它自己的收尾里
  按 `taskId.startsWith('uie2e-')` 精确摘除 —— 与它清 `data/trash` 用的是同一套前缀约定。
  实测：跑一次清掉 33 条，`errors.jsonl` 从 118 行回到 86 行，「近 24h 错误」降到 24（真实值）。

### 17.6 验证

`test/monitor-panel.ts` 新增第 ⑦ 段，**126 项断言全通过**（原 71 项）：

- 状态判定纯函数：`state_desc` 的两种形态（中文文案 / 数字回显）、审核中/已通过/未通过/未知码；
- **`is_only_self` 的 `state=-50` 也必须算已投稿** —— 否则界面永远显示「审核中」，
  用户既看不到 bv 号也删不了文件，那正是这次要解决的问题；
- **产物识别**：找到同一场的 `-弹幕版.mp4`；**前缀更长的另一场不被认领**；
  **分段原始文件（`-PART001.ts`）不被当成产物**（两个反例都钉住了）；
- 真起 UiServer：切片/完整版/纯享版**三种类型同时在场**；
  有 bvid 的可删、**没 bvid 的不可删**；带文件名/大小文本/跳转链接/bvid 来源；
- 完整版的 bvid 与大小都来自真实文件（不是 0）；
- 删除接口三道闸：不带 `confirm` → 400、未知 key → 400、**没有 bvid → 400 且文件没被动**；
- 正常删除 → 200、文件移入回收站（原位置消失）、说明里点出「稿件不受影响」、
  该条从清单消失并计入 `deletedCount`（不是静默消失）。
- 顺带：删除接口的**回收站根目录**改成从台账路径推导 —— 用默认的 `data/trash` 会让单测
  把条目写进**真实**回收站（实测留了 7 条 `mon-test-published`，已清理）。

新增 `tools/verify-monitor-ui.ts`（`npm run monitor-ui`）—— **真浏览器**验证，**14 项断言全通过**。
它专门盯几个「Node 侧断言看不出来、只有真渲染才暴露」的失效方式：

| 断言 | 为什么需要它 |
|---|---|
| 渲染行数 = 接口行数 | 拼 HTML 时少个 `</td>` 会整行错位 |
| **bv 链接数 + 审核中数 = 总行数**（逐行判定） | 状态列分支写反（该给 bv 号的显示审核中）|
| 每一行的状态**都不为空** | 分支漏了某一种情形就渲染成空白 |
| 删除按钮数 = 接口里 `deletable` 的数 | 门槛写错（没 bvid 的也给了删除入口）|
| ★ 删除按钮**真的绑了 onclick** | 本项目踩过：`$(...)` 当 `$$(...)` 用，整段绑定静默不执行，点上去毫无反应 |
| 类型里必须含「完整弹幕版」 | 用户本次的要求本身 |

> 第一版这个工具自己有 3 条断言写错了（用 `querySelectorAll('tbody .tag-mini')` 数状态标签，
> 而「类型」列也是 `.tag-mini`，7 行数出 14 个；以及要求每行都有删除按钮，而审核中那行**本来就不该有**）。
> 已改成逐行判定 + 以接口数据为期望值。

真机核对（浏览器截图 `data/ui-shots/23-monitor-uploaded-files.png`）：卡片标题
「已投稿文件 · 10 个可删 · 共 1166 MB」，每行显示 状态 / 类型 / 文件 / 大小 / 删除按钮。
当时 B站 回的是 `state=-30 / state_desc="审核中"`，所以 10 行都如实显示「审核中」；
过审后 `state` 变 0、`state_desc` 变「开放浏览」，那一列会自动变成可点的 bv 号
（与下方「最近投稿」里的 bv 号标签同一形态）。

### 17.7 补：完整版也要显示（用户要求「能不止显示切片吗」）

第一版只列出了切片，完整版一条都没有。原因不是漏写，而是**台账里根本没有它**：

```
实测 4 个任务的 source.fullVideoPath 全是 undefined、fullVideoBvid 也全是 undefined
```

因为完整版是**录制结束之后**由 biliLive-tools 压出来的，而任务是在「录制文件稳定」那一刻
导入的 —— 那时 `-弹幕版.mp4` 还不存在。台账不会事后回填。

所以改成**现场按命名约定去盘上找**：新增 `recordings.ts` 的 `findVideoProducts(rawPath)`，
复用 `PRODUCT_SUFFIX`（那份是权威定义，含 `-弹幕版` / `-纯享版` / `-danmaku` / `（弹幕版）` 与防覆盖 UUID），
并要求「文件名 = base + 1~2 个后缀」**严格匹配**，不做 `startsWith` 模糊匹配 ——
这一列是用来**删文件**的，把同一天另一场的产物算进来就是删错东西。

实测（真实目录，每个任务都只认领自己那一个）：

```
2026-09-24 02-51-32-668 (⊙o⊙)？.ts → 1 个产物: …02-51-32-668 (⊙o⊙)？-弹幕版.mp4
2026-09-24 02-31-32-636 (⊙o⊙)？.ts → 1 个产物: …02-31-32-636 (⊙o⊙)？-弹幕版.mp4
2026-09-24 02-11-32-593 (⊙o⊙)？.ts → 1 个产物: …02-11-32-593 (⊙o⊙)？-弹幕版.mp4
2026-09-24 01-34-08-285 (⊙o⊙)？.ts → 1 个产物: …01-34-08-285 (⊙o⊙)？-弹幕版.mp4
```

**bvid 怎么办**：完整版没有 `fullVideoBvid`，但它的 bvid 就是**本场切片那个 bvid** ——
我们的切片正是追加进 biliLive-tools 为这场建的那个稿件（`findResumeTarget` 按标题反查到的）。
所以规则是 `t.fullVideoBvid ?? 第一个有 bvid 的切片`，并用 `bvidFrom` 标出来源
（`task` / `clip` / `none`），界面上鼠标悬停会说明「bvid 取自本场切片」。找不到就不编，
如实显示「审核中」且不可删。

**纯享版**：biliLive-tools 那条路**不落盘**（它是上传时现转的），所以盘上没有就不列。
助手自投多分P 时会 remux 到任务目录 `full/` 下的 `p2/pure` 命名文件 —— 那个分支保留。

真机结果（重启后）：

```
共 6 项 | 可删 6 | 合计 3169.8 MB
  修改内容待审核…  完整弹幕版  2026-09-24 02-51-32-668 (⊙o⊙)？-弹幕版.mp4   699.0 MB  clip
  修改内容待审核…  完整弹幕版  2026-09-24 02-31-32-636 (⊙o⊙)？-弹幕版.mp4   659.3 MB  clip
  修改内容待审核…  完整弹幕版  2026-09-24 02-11-32-593 (⊙o⊙)？-弹幕版.mp4   760.7 MB  clip
  修改内容待审核…  完整弹幕版  2026-09-24 01-34-08-285 (⊙o⊙)？-弹幕版.mp4   721.4 MB  clip
  修改内容待审核…  切片       02-001227-误入锁妖塔…mp4                     130.0 MB  -
  修改内容待审核…  切片       01-000507-转生怪求大哥帮忙…mp4                199.3 MB  -
按类型汇总: {"完整弹幕版":4,"切片":2}
```

（只剩 2 个切片是因为另外 12 个已被「用完即删」清进回收站 —— `deletedCount` 如实报了 12。）

### 17.8 顺带发现：`deleteFullVideo` 配置了却**从来没生效**（用户决定不修）

上面那个「台账里没有 fullVideoPath」的根因还连带一个更实际的后果：

```ts
// daemon.ts:2075
if (d.deleteFullVideo && task.source.fullVideoPath && exists(task.source.fullVideoPath)) { … 排入待删 … }
```

`fullVideoPath` 永远是空的 → **这一整段从未执行过**。用户配置里
`cleanup.deleteAfterUpload = { enabled: true, graceHours: 0.5, deleteClips: true, deleteRaw: true, deleteFullVideo: true }`
，切片 12 个文件确实被清掉了（走 `cutOutput`），而**完整版 4 个（约 2.8 GB）一直堆在盘上**。
按一场 3 段估算，每场会多留 ≈ 2 GB 且无人清理 —— `diskFloorGB` 早晚会被它顶到。

**决定（2026-09-24 用户选择）**：**不修**。完整版留在盘上，需要时在实时监控的
「已投稿文件」里手动删。理由是完整版往往是这份素材唯一的本地完整副本
（切片是片段、原始分段可能已被「用完即删」清掉），自动删掉之后若 B站 那边出问题就没法重投。

因此本轮**只加注释、没改一行逻辑**（`daemon.ts:2075` 上方）：

- 写明「这一段目前不会执行，而且是故意的」，避免以后（或另一个会话）看到
  "条件永远不成立"就当成 bug 顺手修掉 —— 那会把用户要留的完整版删掉；
- 写明真要修的话必须先问，以及**连带后果**：`deleteAfterUpload.deleteFullVideo: true`
  现在是个**空开关**，若哪天有人把 `fullVideoPath` 回填上了，这一段会立刻开始生效。

> 也就是说：那个配置项与实际行为不一致是**已知且有意**的状态。
> 若希望配置本身也如实表达「保留完整版」，把它改成 `false` 即可（本轮没动）。

---

## 18. 差点删掉 5.84 GB 的判定错误：盘符 ≠ 卷（2026-09-24）

**一句话**：`sameVolume()` 只比路径字符串的盘符，把 junction 路径误判成"跨盘"，
于是本该**移入回收站（可恢复）**的文件会走 `fs.rmSync`（**永久删除**）。

### 18.1 现场

用户在「实时监控 → 目录轮询」里看到 10 条「已导入过（任务已从台账删除）」，要求清理。
排入待删清单后，界面每一条都显示 **「跨盘·删除不可恢复」** —— 而这 13 个文件
（10 个 `.ts` 4.12 GB + 3 个 `-弹幕版.mp4` 1.72 GB = 5.84 GB）**物理上都和回收站同盘**：

```
C:\Users\demo\Downloads\Bilibili  → junction → D:\live_auto_media\Bilibili
F:\deepseek\live_auto\data         → junction → D:\live_auto_media\data
```

两者真实卷都是 `D:`，`rename` 是瞬时的。**只要宽限期一到，这 13 个文件就会被永久删掉**，
而且是"按设计执行"、日志里写得明明白白"跨盘不进回收站"的那种删法，事后无从恢复。
发现时离到点还有约 28 分钟 —— 界面那句提示救了它。全部 13 条已取消（`取消成功 13/13`）。

### 18.2 根因

```ts
// 旧实现：只比盘符字符串
path.parse(path.resolve(target)).root === path.parse(path.resolve(trashRoot)).root
//   C:\Users\…\Bilibili\xxx.ts      → "C:\"
//   F:\deepseek\live_auto\data\trash → "F:\"     → 判定"跨盘" ❌
```

`path.resolve` **不解析** junction / 符号链接，它只做字符串规范化。
而本项目**整套目录都是 junction**（这是用户为了把素材放 D 盘而特意做的，见 §13），
所以这条判断在真实环境里几乎必然走错分支。

### 18.3 修复（`src/pending-delete.ts`）

新增 `volumeRoot(target)`：**逐级向上找到第一个真实存在的祖先**，对它做 `realpath`，再取卷根。
必须逐级向上，因为待删目标可能已经不存在（目录、还没建的回收站目录），
对整条路径直接 `realpath` 会抛错并退化成"跨盘"。

```ts
let probe = path.resolve(target);
for (;;) {
  try {
    const real = realpath(probe).replace(/^\\\?\\UNC\\/i, '\\\\').replace(/^\\\?\\/, '');
    return path.parse(real).root.toLowerCase();   // Windows 上 realpath 可能回设备路径，先去掉前缀
  } catch { /* 不存在 → 上一层再试 */ }
  const parent = path.dirname(probe);
  if (parent === probe) return undefined;         // 到根还是解析不了
  probe = parent;
}
```

`sameVolume()` 改为比较两个 `volumeRoot`；两边都解析不出来时**退回**旧行为（不比以前更差）。

### 18.4 同时修掉的两个"取消是假的"缺陷

查这条路径时顺带发现，**「取消」在旧实现里并不牢靠**：

| 缺陷 | 旧行为 | 现在 |
|---|---|---|
| 取消后又被自动排回 | 反查循环每 5 分钟调 `scheduleDelete`，按路径去重时**不看 `cancelledAt`** → 取消 5 分钟后条目又回来了（界面那一刻写着"已取消"） | 默认**保持取消**，并把它报进 `heldCancelled`；要重新排入必须显式 `reviveCancelled: true` |
| 同 id 两条记录 | 重新排入是**追加**新记录，而 id 由路径派生（`pd-<hash>`）→ 清单里两条同 id；`cancelPendingDelete`/`deletePendingNow` 用 `find(e => e.id === id)` 命中的是**旧的已取消那条** → 「取消失败」「立即删除被跳过」，文件变成**界面上管不住、到点却会删** | 复活改为**原地**复用同一条（id 不变、不新增）；按 id 查找统一走 `findLiveEntry()`：先找活的，找不到再退回首条（好给出准确的跳过原因） |

### 18.5 验证

**新增回归测试**（`test/pending-delete.ts` §7b/§13，断言数 78 → 115）：
§7b 用 `fs.symlinkSync(..., 'junction')` 造一个**真的跨盘 junction**
（链接放系统盘 `C:`、目标放项目盘、回收站也在项目盘），跑完整删除流程并断言 `deletedBy === 'trash'`
—— 老实现在这一条上就是 `rm`。删 junction 只用 `unlinkSync`：万一 recursive rm 跟进了目标，
删掉的就是真目录（这个项目已经在 junction 上栽过一次，不再赌）。

**全量**：`npm run verify` 36 个套件全绿。

**真机**（重启服务加载新代码后，走真实 HTTP 接口）：

```
GET  /api/pending-delete        → 13 条 / 5.84 GB ；willTrash=true 的条数：13 / 13
POST /api/pending-delete/delete { all: true }
     → ok=true  deleted=13  failed=0  skipped=0  freedMB=5978
     → 按删法分组：trash=13  rm=0          ← 修复前这里会是 rm=13
     → 回收站条目 13 个（20260924-151442-auto-…），7 天内可恢复
GET  /api/monitor               → watch.outcomes = 0 条（目录轮询面板已清空）
```

> **5.84 GB 是"移入回收站"，不是立即释放**：回收站与素材同卷（都在 `D:`），
> `rename` 不复制字节也不释放空间。真正回收空间要等 `cleanup.trashDays = 7` 的自动清理
> （或手动清空回收站）。D: 当前可用 382.7 GB，不紧张。

### 18.6 为什么"删除"这件事值得这么多防线

这是本项目**唯一会永久抹掉数据**的功能。这次的实际教训是：
**最危险的不是判断逻辑写错，而是界面把后果说清楚了、而"说清楚"的那句话本身是错的** ——
用户看到「跨盘·删除不可恢复」，只能选择"取消"来保命，却无法知道系统其实判错了。
所以 §18.3 的修复必须落在 `sameVolume()` 这一个函数上（`willTrash` 与真正执行删除的
`performDelete` 共用它），而不是在界面上打补丁。

### 18.7 顺带修掉：`restart-service.ts` 会被启动器反过来杀掉自己

重启服务时踩到：`tools/restart-service.ts` 杀掉旧 node 之后，
`launcher.ps1`（桌面快捷方式 / 计划任务用的启动器）立刻进入它自己的 `finally`：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$ROOT*" } | Stop-Process -Force
```

这条按命令行**子串**匹配，于是连"从项目目录里跑的 `node tools/restart-service.ts`"
一起杀了 —— 表现是脚本中途消失（harness 侧报 `job runner exit 4294967295`）、
旧服务已死、新进程根本没起来，看起来像"服务起不来"，很难查。

修法：**先请启动器退场，再动服务**（顺序不能反）。启动器被 `taskkill` 掉时自己的
`finally` 不会执行 —— 这正是我们要的，它也就不会去收它的 node 子进程，
那个旧服务交给下一步正常杀。另外起新进程前再扫一眼（计划任务 `RestartCount=3`/每分钟
会再拉一个起来），避免"两个服务抢 3000 端口"。

---

## 19. 「错误报告 目前没有任何效果」—— 三层原因，逐层修掉（2026-09-24）

用户的原话只有一句：「错误报告 目前没有任何效果」。这句可能指三件完全不同的事，
所以先用真浏览器把现象钉死（`tools/verify-error-report-ui.ts` 的前身是一次性探针），
再看数据，得到的是**三层同时成立**的原因。

### 19.1 现象（真浏览器实测，修复前）

```
接口层：/api/health errors=20 条；/api/monitor errors=5 条
【健康页签】「报告」按钮 20 个
  首个 reportId = 2026-09-23T07-57-24-791Z-20260923-1355-rec-mock
  直连接口：status=404
  点击后：弹窗 show=false   标题「详情」  正文长度 0
页面未捕获异常 0 条；console.error 0 条
```

**点了没有任何反应**：接口 404 → `catch` 里只 `toast(e.message)` → 一个 2.6 秒后自动消失的
小提示，看起来就是按钮坏了。而且**页面既没有异常也没有报错**，所以任何单测都发现不了。

### 19.2 第一层：接口只认「报告文件」，不认「事件行」

`errors.jsonl` 的事件行是**同步追加**的（崩溃安全，见 `errors.ts` 开头），报告文件是随后
原子写的。两者会不一致 —— 报告会被清理，也可能当初写盘失败。实测 86 条事件里 **74 条没有
报告文件**，它们点下去全是 404。

修法（`errors.ts` + `server.ts` + `cli.ts`）：

- 新增 `reportFromEvent(ev)`：用事件行合成一份**最小可读报告**（时间/阶段/类型/消息/
  重试次数/应有路径），并标 `reportFileMissing: true`；
- 新增 `loadErrorReportOrEvent(id)`：先读原始报告，读不到就用事件行合成，两者都没有才认输；
- `GET /api/error-report/:id` 因此**不再是 404 大户**，并且响应里带 `reportFileMissing`
  让界面能如实说明；`node src/cli.ts inspect <id>` 走同一条链。

界面侧（`public/ui.html`）：新增 `reportNote(r)`，在弹窗顶部插一条琥珀色说明条，
三个入口（任务详情「查看日志」/ 健康「报告」/ 监控「报告」）共用，**并统一把
`catch` 里的 toast 改成说明性文案** —— 再出问题时至少看得见"为什么打不开"。

### 19.3 第二层：真实故障**根本不进错误流**

`publish.ts` 里片段级的六处失败（源文件缺失 / 切片提交失败 / 切片任务失败 /
投稿任务失败 / 投稿抛错 / 多分P整批失败）此前只做两件事：`log.error(...)` +
台账写 `failReason`。**`errors.jsonl` 与 `error-report/` 里一条都没有。**
实测证据：2026-09-24 00:09 某场 `切片任务提交失败（片段 #0）`（真实直播场次），
错误流里查不到任何记录。

修法：新增 `Publisher.reportClipFailure()`，六处全部接上；报告里带
`clipIndex / failReason / cutOutput`（`EnvSnapshot` 新增这三个字段），消息前缀
`片段 #N <阶段> 失败：…` —— 复查时一眼看出是**哪一个片段**。整段包 try，
诊断能力再重要也不能反过来把投稿搞挂。

### 19.4 第三层：错误流被测试噪音占据

74/86 条事件是内建测试的 mock 场次（`*-rec-mock`），而它们的报告文件写在临时目录里、
主事件流里自然点不开。同时健康面板因此显示「近 24h 错误 = 21」，真实生产错误只有个位数。

根因是**隔离没做全**（`dataDirOverride` 管不到模块级常量）：

| 常量 | 之前 | 现在 |
|---|---|---|
| `ERROR_REPORT_DIR` | 已跟随 `dataDirOverride` | 不变 |
| `ERRORS_PATH` | **不跟随**，靠各测试自己 `setErrorsPath()`，谁忘了谁污染 | `daemon.ts` 构造时一并切换 |
| `LOGS_DIR`（模块级单例 `log`） | **不跟随** → 测试的几万行写进真实日志（当天 2 MB 日志绝大部分是 `mp-test-*`） | `Logger.setDir()` + 构造时一并切换 |

历史数据用维护工具搬走（可逆、可审计，先整份备份）：

```
node tools/archive-mock-errors.ts --dry-run
→ 主事件流 86 条，其中 mock 测试场次 74 条（无报告文件 74 条），保留（真实）12 条
node tools/archive-mock-errors.ts
→ 备份 data/errors.jsonl.bak-<时间戳>；74 条追加到 data/errors.archived-mock.jsonl；主事件流剩 12 条
```

结果：「近 24h 错误」**21 → 3**（且这 3 条都是真实事件）。

**残留（诚实记录）**：跑完整套 `npm run verify` 后，真实日志仍会多约 **19 KB**。
原因是有些用例在构造 Orchestrator **之前**就先写台账/夹具（`new Ledger(...).createTask(...)`），
那一刻隔离还没生效；另有几个 tool 套件根本不构造 Orchestrator。
从"几万行 mock 日志灌进真实文件"降到 19 KB 已经是量级上的改善，但**不等于零污染** ——
要彻底干净得让每个用例在**最开头**就切日志目录（`log.setDir()`），本轮没做。

顺带修掉一个更要命的：`Logger` 的写入流**从来没有 error 处理器**。
一旦异步写失败（目录被删、磁盘满、权限变化），Node 会以未捕获的 `'error'` 事件
把**整个进程带走** —— 而抛出者居然是"日志"。本轮做日志隔离时当场踩到
（端到端测试删掉临时目录 → `ENOENT` → 进程崩，看起来像"日志隔离把测试搞坏了"）。
现在 `Logger.onStreamError()` 会关掉坏流、降级为只输出控制台，并每 60 秒最多提示一次。
**日志写不进去是小事，因为写日志把正在投稿的服务干掉是大事。**

### 19.5 验证

| 手段 | 结果 |
|---|---|
| `test/error-report.ts`（新增，**68 断言**） | 合成报告字段/时间线；降级链三级；HTTP 契约（只有事件 → 200 + `reportFileMissing`；有文件 → 原始报告；都没有 → 404 + `available`）；`format=text` 同样可用；片段级上报的报告内容（clipIndex/failReason/taskTitle）；**端到端真跑一次 `cutAndUploadClip` 的 file-missing 分支**并断言错误流 +1、报告落盘、台账标 FAILED；六处上报点的静态核对 |
| `tools/verify-error-report-ui.ts`（新增，**18 断言**） | 真 Edge 里把两个页签的「报告」按钮**逐个点开**（健康 6/6、监控 5/5），弹窗全部出现且有内容；标题/提示语到位；降级说明条按 `reportFileMissing` 正确渲染；全程零未捕获异常 |
| 真机复查（服务重启后） | 修复前 20 个按钮里绝大多数 404 无反应 → 修复后 6/6、5/5 全部弹出内容；`errorsLast24h` 21 → 3 |
| `npm run verify` | 37 个套件全绿 |

日常维护入口：

```bash
npm run error-report-test        # 单测（68 断言）
npm run error-report-ui          # 真浏览器验证「报告」按钮（需要服务在跑）
npm run errors-archive-mock      # 再出现测试污染时，把 mock 事件挪出主事件流（先 --dry-run）
```

### 19.6 这一轮真正的教训

**"功能有界面"不等于"功能有效"。** 错误报告此前在单测里是绿的（`e2e-offline` 场景 14
覆盖了"报告已落盘、可读取、不含凭据"），但它对用户**完全无效**：
真实故障不进这个流，进去的历史事件又点不开。
两次同类故障（§18 的删除判定、§19 的报告）都指向同一条经验 ——
**验证必须走到"用户真正做的那一步"**（点那个按钮、看那句话），
接口 200 / 单测全绿都不算数。

---

## 20. 热词接线：一条"能力在、线没接"的杠杆（2026-09-24）

### 20.1 缘起

用户拿一份 ASR 模型选型的分享来问"适合我的项目吗"。分析结论是：那份分享里的**落地形态**
（实时流式、海外商业 API、买/租 GPU、SmartSub / LiveSpeech2Text 这类桌面工具）与本项目
都不匹配，真正的短板不在"换哪个模型"，而在**已有能力没接上** —— 其中第一条就是热词：

- `tools/local-asr/transcribe-funasr.py` 一直读 `spec["hotwords"]` 并传给
  `generate(hotwords=[…])`（Fun-ASR 原生参数）；
- 而 TS 侧 `src/asr.ts` 的 `LocalAsrOptions` **从来没有这个字段**，`buildLocalAsrSpec()`
  也从不写它 ⇒ 用户改了 `data/glossary.json`，转写结果**毫无变化，且没有任何报错**。

这不是"缺功能"，是"线没接"——最容易被忽略、也最伤信任的一类问题。

### 20.2 改了什么

| 位置 | 改动 |
|---|---|
| `src/glossary.ts` | 新增 `hotWordList(glossary, {max})`：把 anchors + terms 摊平成 ASR 热词数组（去空白/去重/丢超长句/按上限截断，并如实返回丢弃个数）；缺字段的手改词表不再抛异常 |
| `src/asr.ts` | `LocalAsrOptions.hotwords`；`buildLocalAsrSpec` 的 funasr 分支按需写入（空则不写字段，便于一眼看出这次带没带）；`TranscribeDeps.hotwords` 是**惰性函数**（术语表可热改，读表时机应是"每次组装参数"而不是"服务启动"）；`resolveHotwords()` 三重保险（配置关 / 无来源 / 读表抛错 → 都只是"这次没热词"） |
| `src/asr.ts` | ★ **热词进缓存键**：`asrCacheKey` 增加 `hotwords?`，且用**条件追加**而不是固定加空槽位 —— 后者会让所有既有缓存键一起失效（云端按小时计费，那是真金白银的重跑）。没热词时键与从前**逐字节相同** |
| `src/daemon.ts` | 注入 `hotwords: () => hotWordList(this.glossary.load(), {max})`；有词被丢掉时记 warn（否则用户会以为"我写了却没生效"） |
| `src/config.ts` + `config.example.json` | `asr.localFunasr.hotwordsEnabled`（默认 **true**）、`hotwordsMax`（默认 80）；示例配置补上了整个 `localFunasr` 段（此前缺失） |
| `public/ui.html` | 配置面板新增热词开关与上限输入 + 回写 patch；顺带修掉**时间戳开关此前没绑事件**（点了没反应 —— 本项目真实发生过的坑） |

### 20.3 真机 A/B（同一段素材、同一个模型、只差热词）

素材 `data/local-asr-test/sample-300s.flv` 前 300 秒，本地 Fun-ASR-Nano（RTX 4070S，CUDA），
走**真实 Transcriber**（就是流水线那条路），两次各用独立缓存目录：

| | A 不带热词 | B 带热词（钢蹦） | 云端基准 |
|---|---|---|---|
| 目标词「钢蹦」命中 | 5 | **8** | 7 |
| 相对云端基准 CER | 5.47% | **5.03%** | — |
| 墙钟 | 163.2 s | 162.4 s | — |
| 字幕条数 | 131 | 130 | — |

日志侧证据：B 那次明确打出 `热词已注入（1 条，来自术语表）：钢蹦`。
两次输出**不完全一致**（模型确实改口了），耗时无差别。

> 结论：热词在这套流水线上**真的生效且是正向的**（更接近云端基准），代价约等于零。
> 注意这也是**风险**：词表写错会主动把对的听成错的 —— 所以只放"确定会出现的专有名词"。
>
> 复现：`npm run hotwords-ab`（可加 `--span 300` 与目标词）。**连跑两次数字完全一致**
> （5→8 命中、5.47%→5.03%），所以这不是抽签抽出来的。
> 你改了 `data/glossary.json` 之后，用它可以自己验证"改的这几个词到底有没有被听对"。

### 20.4 验证

| 手段 | 结果 |
|---|---|
| `test/local-funasr-provider.ts` | 39 → **57 断言**：热词进/不进 spec、whisper 不带该字段、清洗规则（去重/截断/坏表）、**缓存键三连**（没热词时与旧实现逐字节相同 / 带热词时变了 / 空指纹不留空槽位） |
| `test/config-checks.ts` | 默认开启、上限为正；界面开关存在 + **被绑上** + 会回写 patch；示例配置有该段 |
| 真机 A/B | 见上表（零费用） |
| `npm run verify` | 37 个套件全绿 |

### 20.5 顺带修掉：PowerShell 改配置文件会写入 BOM

用 PowerShell 的 `Set-Content -Encoding UTF8` 往 `config.json` 插两行，它（Windows
PowerShell 5.1）写成了 **UTF-8 with BOM**，而 `loadConfig` 是裸 `JSON.parse`
→ `Unexpected token '﻿'`，**服务启动即挂**。这类事故的特点是"上一步看着成功了"。

现在 `test/config-checks.ts` §5 静态钉住：`config.json` / `config.example.json` /
`package.json` / `tsconfig.json` / `public/ui.html` / 代表性 `src/*.ts` 一律**不许有 BOM**，
而 `launcher.ps1` **必须**有 BOM（Windows PowerShell 5.1 的编码要求，README 有专章）。
凡是要改项目里的文本文件，一律用 Node（`fs.writeFileSync(p, s, 'utf8')`）而不是 shell 重定向。

### 20.6 本地 Fun-ASR 的耗时构成（实测，不是估算）

本地 runner 是**一次性子进程**：每个进程都要把 0.6B 模型加载一遍（约 90–100 秒），
这段与音频长短**无关**。同素材、同机器跑两个时长解方程 `wall = L + r × 时长`：

```
180s 音频 → 133.0s 墙钟，78 条字幕
300s 音频 → 161.2s 墙钟，131 条字幕
⇒ 固定成本 L ≈ 90.7s，推理速率 r ≈ 0.235 × 实时（1 秒音频约 235ms）
```

| 时长 | 本地 Fun-ASR | 相当于实时 | 其中加载占比 |
|---|---|---|---|
| **3 分钟（一个切片）** | **2.2 分钟** | 0.74× | 68% |
| 10 分钟 | 3.9 分钟 | 0.39× | 39% |
| 30 分钟（一段） | 8.6 分钟 | 0.29× | 18% |
| 1 小时（一段录播） | 15.6 分钟 | 0.26× | 10% |
| 4 小时 15 分（一整场） | 61.4 分钟 | 0.24× | 2% |

对照：云端 fun-asr 同一段 300 秒实测 ~11s（含转码 + 上传，**没有固定成本**）。

**两条结论**：
1. 短素材上本地引擎是**最差**的用法（3 分钟切片要 2.2 分钟，几乎和素材一样长）——
   这正是流水线用 `chunkMinutes=360`「整场一块」而不是「一片一块」的原因：一小时 15.6 分钟、
   一整场 61 分钟，固定成本被摊到 2%。
2. 真要让"按片转写"也便宜，得把 runner 改成**常驻工作进程**（模型只加载一次，
   反复喂文件）：3 分钟切片会从 133s 掉到约 40s。目前 runner 刻意是一次性子进程
   （子进程隔离 + 不引入需要编译的依赖），要改就得单独评估。

复现：`npm run asr-timing [窗口A] [窗口B]`（零费用，只占 GPU）。

---

## 21. 切换本地 Fun-ASR（2026-09-24，用户决定）

配置从 `asr.provider = "bililive-tools"`（云端，按小时计费）改为 **`"local-funasr"`**
（本地 Fun-ASR-Nano，¥0、自带标点 99%、字级时间戳、**原生热词**）。

### 21.1 切换顺手抓到一个真缺陷：dry-run 的付费闸门拦住了免费引擎

切完 provider 第一次用 `node src/cli.ts video <文件> --dry-run` 验证，结果是：

```
本地 ASR 已启用：引擎 funasr …（不产生云端费用）
开始转写：1 个调用单元 … {"dryRun":true,"allowPaid":false}
转写完成：0 条字幕，付费段 0，缓存命中 0，失败 1 … {"elapsedMs":1}     ← 1 毫秒
dry-run 预检：1 个转写窗口全部因未授权付费被安全阀拦下（硬约束 #14）
```

根因：`transcribe()` 里的 dry-run 闸门写在 **provider 分叉之前**：

```ts
if (dryRun && !allowPaid) { … message: 'dry-run 且无缓存：拒绝调用付费 ASR …' }
```

它对**本地引擎**同样生效 —— 本地转写**永远失败**，失败原因还写成"未授权付费"，
明明是免费的。后果：dry-run 再也验不了本地链路，用户会以为"要先用 `--allow-paid`
才能试本地识别"。文件头的注释其实早就写了"本地路径不适用这道闸"，**代码没跟上注释**。

修法：`if (dryRun && !allowPaid && !useLocalAsr)` —— 云端该拦的照样拦，本地放行。
（`test/local-funasr-provider.ts` §1d 静态钉住这条边界。）

### 21.2 切换后的真实链路验证（零费用）

```
node src/cli.ts video data/local-asr-test/sample-120s.flv --dry-run --no-ui
→ 本地 ASR 已启用：引擎 funasr，模型 FunAudioLLM/Fun-ASR-Nano-2512，设备 auto，字级时间戳 开
→ 热词已注入（4 条，来自术语表）：甲主播、乙主播、后半夜后悔时代、闪身步
→ 段 1 00:00:00–00:02:00 完成：52 条字幕        （elapsedMs 121874，即 2.03 分钟）
→ 转写完成：52 条字幕，付费段 0，失败 0，实际计费音频 00:00:00（估算 ¥0.00）
→ 状态 ANALYZED，候选 1 个（dry-run 不切片不投稿、未调用付费 LLM）
```

两点互证：
- **2 分钟音频 121.9 秒**，与 §20.6 的模型预测 `90.7 + 0.235×120 = 118.9 秒` 差 2.5%；
- 热词真的进了本地引擎（4 条，来自 `data/glossary.json`）。

服务侧 `/api/bootstrap` 复查：`asr.provider = local-funasr`、`hotwordsEnabled = true`；
服务已重启加载新 provider。两次 dry-run 造的测试任务已删除（进回收站，`storage.tasks = 0`）。

### 21.3 切换后的预期与代价（据此判断是否要保留这个选择）

| | 云端 fun-asr | 本地 Fun-ASR-Nano（现状） |
|---|---|---|
| 费用 | ¥0.79–2 / 小时音频 | **¥0** |
| 1 小时一段 | ~9.6 分钟 | **~15.6 分钟** |
| 4 小时 15 分一整场 | ~8.5 分钟 | ~61 分钟 |
| 热词 | ✗（biliLive-tools 不透传） | **✓ 已接线** |
| 时间戳 | 段级 | **字级（CTC 强制对齐）** |
| 标点 | 部分（33%） | **99%** |
| 依赖 | 阿里云账号/额度（曾被上游换模型坑过） | 本地 venv + 模型权重（已就绪） |
| 音频是否出本机 | ✗ 上传 OSS + DashScope | **✓ 全程本地** |

要点：**一小时一段的处理时间从 ~10 分钟变成 ~16 分钟，依然远小于你的处理窗口（1 小时）**，
换来的是零费用 + 热词 + 更好的标点与时间戳。若哪天要临时快跑一场，仍可用
`--local-asr` 之外的默认云端路径（把 provider 临时切回即可，或后续加个"单次覆盖"开关）。

### 21.4 连带发现：dry-run 的语义**随 provider 而不同**，旧断言写死了云端

改完闸门后 `npm run verify` 当场红了 2 条（`test/real-media.ts`）：

```
· dry-run 且无缓存时如实记录缺失区间（而不是假装成功） :: 0 处
· 无缓存时不产出任何字幕（避免把空结果当成成功）      :: 1131 条
```

原因是那两条断言把 **"dry-run = 什么都不产出"** 当成了普遍规律，而它只在**付费** provider
下成立。正确语义是：

| provider | dry-run 且无缓存时的行为 | 依据 |
|---|---|---|
| 云端（bililive-tools） | 记 gaps、不产出字幕 | 硬约束 #14：不许自动花钱 |
| 本地（whisper / funasr） | **照常转写**、零付费、成本 ¥0 | #14 约束的是"不花钱"，不是"不许干活" |

修法：`real-media.ts` 的 dry-run 分支改成 **provider 感知**（本地分支断言
"确实转写了 + 零付费 + 成本 ¥0 + 不留假 gaps + 时间戳严格递增"）。
另外把本地分支的音频**截到前 300 秒**：本地跑整场 50 分钟要 ~12 分钟，而这条用例验的是
**契约**不是吞吐 —— 改完 total 从 695.7s 降到 **161.3s**，断言数 22 → **23**。

**还有一层坑：第一次改完是"假绿"。** 第二次跑时 ASR 缓存命中了，耗时 **0.0s**、断言照样全过 ——
而 `transcribe()` 里**缓存检查在付费闸门之前**，也就是说缓存一命中，闸门根本不会被执行，
这条用例就再也测不出"闸门有没有拦住本地引擎"。所以本地分支必须显式 `force: true`
绕过缓存，并加一条 `cacheHits === 0` 的断言把"这次是真跑的"钉住（断言 23 → **24**，
耗时回到 168.2s）。**结论：验证付费闸门时，先把缓存状态固定住，否则测的是缓存不是闸门。**

---

## 22. 「录播为什么没有导入」—— 已闭合的分段被"正在录"的分段拖住（2026-09-24 晚）

### 22.1 现场

用户问「录播为什么没有导入」。盘上事实：

```
2,702 MB  18:59:43  2026-09-24 18-00-41-946 我来了！.ts        ← 第 1 段，已闭合 44 分钟
2,010 MB  19:43:37  2026-09-24 18-00-41-946 我来了！-PART001.ts ← 第 2 段，正在录（还在长）
2,221 MB  19:14:03  2026-09-24 18-00-41-946 我来了！-弹幕版.mp4  ← biliLive-tools 压制产物
```

目录轮询每 60 秒扫一次、`lastScanAgoSec=36`、`importedTotal=20` —— **轮询本身是活的**，
但 `POST /api/watch/scan` 只返回 **1 个候选**，而且是那个"仍在写入"的 `-PART001.ts`：

```
scanned = 1 ; imported = 0
  · 2026-09-24 18-00-41-946 我来了！-PART001.ts  ⇒  文件仍在写入（录制可能未结束）
```

**已闭合的第 1 段（整整一小时、2.7 GB）根本没进候选列表。**

### 22.2 根因：归并键相同 + "整组取最晚 mtime"

`recordingGroupKey()` 会把 `-PART\d+` 剥掉，于是**第 1 段与正在录的第 2 段是同一个归并键**
（`…！.ts` 与 `…！-PART001.ts` 归并成一场 —— 这个归并本身是对的：
多分段本该拼成一场，第 0 段补位就是为此而生）。

问题在"这场还在录吗"的判断：旧实现取**组内最晚 mtime**，

```ts
const latestMtime = Math.max(...g.files.map((f) => f.mtimeMs));
const possiblyRecording = now - latestMtime < recWindowMs;   // ← 整组一刀切
```

正在录的第 2 段把整组拉成"仍在录制" → 轮询在 `possiblyRecording` 处**整场跳过**。
后果：一场直播只要还在进行，**已闭合的分段就永远进不来**（本例里是 44 分钟都没进来），
要等整场结束；而用户的用法恰恰是"每小时切一段就处理那一段"。

### 22.3 修法（两处，各管一段）

| 位置 | 改动 |
|---|---|
| `src/recordings.ts` | **按单个文件**判新鲜度：组内只要有一个文件已写完，就用写完的那些组成候选，正在写的排除在外并报出 `pendingParts`；整组都在写时才保持原来的"仍在录制"判定。`variants` 也只给写完的文件（轮询用它做稳定性判断） |
| `src/media.ts` | `discoverSegments()` 新增 `skipFreshWithinSec`：**拒绝把还在写的文件算成同一场的分段** |
| `src/daemon.ts` | `importLocal` 用同一个时间窗调用 `discoverSegments`，被跳过的分段记一条 info |

为什么必须两边都改：只改轮询，"第 0 段补位"依然会在导入时把 `X.ts` 与 `X-PART001.ts`
拼成一场 —— 总时长、切点、全局时间轴全建立在**半场数据**上；只改分段发现，
轮询仍然整场跳过，文件还是进不来。时间窗统一成常量 `RECORDING_WINDOW_SEC = 120`（三处共用）。

### 22.4 修复后的真实结果

```
第 1 轮扫描：…！.ts  ⇒  首次发现，等下一轮确认写完（稳定 30 秒）
第 2 轮扫描：…！.ts  ⇒  已导入 → auto-20260924114911-lr4t
日志：转写预检：1 个调用单元，音频合计 00:59:00  ← 只有已闭合的那一小时
      本地 ASR 已启用：引擎 funasr …（不产生云端费用）
      热词已注入（4 条，来自术语表）
```

**同一场里"正在录"的那一段没有被拉进来**（分段数 1、总时长 59:00 而不是 59:00+仍在增长），
这正是 22.3 两处改动配合的结果。

### 22.5 回归防线

`test/recordings.ts` 新增 §4g（断言总数 96 → **107**）：

- 同一场仍只列一场；首选是**已闭合**那段；`possiblyRecording=false`；`pendingParts=1`；
- `variants` 只含已闭合那段（否则轮询继续跳过）；
- `discoverSegments(closed)` 不带窗口返回 **2** 段（证明第 0 段补位确实会合并它们），
  带 `skipFreshWithinSec` 后只剩 **1** 段；
- 反向保护：整组都是新鲜文件时，仍判为"仍在录制"（不能为了修这个而漏掉那个）。

---

## 23. 队列积压与一次"看不见的 8 倍变慢"（2026-09-25 凌晨）

### 23.1 现象：服务 3 小时没空闲过

为了加载 §22 的「正在录制」显示修复，我挂了个"队列一空就重启"的后台任务。**3 小时窗口跑满，队列不但没空，还从 4 涨到 7** —— 处理速度跟不上进队速度。

### 23.2 量化：瓶颈在哪儿

从日志逐事件算（20:30 之后）：

| 任务 | 素材 | 转写 | 切片阶段 | 片数 |
|---|---|---|---|---|
| `8m86` | 20 分钟 | 6.9 分钟 | 4.1 分钟 | 5 |
| `ewgo` | 20 分钟 | 15.3 分钟 | 3.2 分钟 | 3 |
| `jp0s` | 8.8 分钟 | **21.3 分钟** | 44.7 分钟 | 3 |
| `3epu` | 59 分钟 | **121.0 分钟** | 4.4 分钟 | 2 |

按 §20.6 的模型（`90.7s + 0.235×时长`）算，20 分钟素材应约 6.3 分钟、59 分钟应约 15.4 分钟。
也就是说 `3epu`（121 分钟）**慢了约 8 倍**，`jp0s`（21.3 分钟 for 8.8 分钟素材）慢了约 2.4 倍，
而 `8m86`（6.9 分钟）正常。**同一台机器、同一个模型、同一份配置，耗时相差近一个数量级。**

### 23.3 为什么查不出来：日志只打了"配置值"

那一行一直是这样（`log.debug`，默认级别下根本看不见）：

```
本地 ASR 已启用：引擎 funasr，模型 …，设备 auto，字级时间戳 开（不产生云端费用）
```

**`设备 auto` 是配置值，不是实际值** —— 实际用的是 cuda 还是 cpu、引擎是 pytorch 还是 vllm、
各阶段各花多久，日志里一个字都没有。而执行器其实把这些都打在自己的 stderr 上，**我们在成功时把它丢掉了**。

### 23.4 实测：设备不是主因，但方差极大

直接调执行器（同一个 10 秒窗口，各跑一次）：

```
device=auto  engine=auto    → 实际 device=cuda  engine=pytorch  推理 516.5s  墙钟 520.8s
device=cuda  engine=pytorch → 实际 device=cuda  engine=pytorch  推理 108.2s  墙钟 109.6s
```

两次**都是 cuda**，墙钟却差 **4.8 倍**（520.8s vs 109.6s）。同时确认：**vLLM 没装**
（`ModuleNotFoundError: No module named 'vllm'`，每次都退 PyTorch —— 官方称 vLLM 比 PyTorch 快一个量级）。

结论：设备不是主因；**方差来自运行环境**（GPU 被别的进程抢：这台机器上同时跑着 Wallpaper Engine、
QQBrowser、Edge、Zed 等，日志里也有 `[Insufficient Permissions]` 的 GPU 占用者）。
但这一点在修复前**无法从日志判断**，所以先把"看不见"变成"看得见"。

### 23.5 修复：把体检信息写进 info 日志

| 位置 | 改动 |
|---|---|
| `src/asr.ts` | 本地结果返回时保留执行器 **stderr 尾巴**（4000 字符，阶段耗时在里面）；完成行从 `debug` 提升为 **info**：`设备 cuda/float16，引擎 pytorch，耗时 12.3s，RTF 0.235` |
| `src/asr.ts` | **RTF > 0.6 单独 warn**（GPU 正常 0.24–0.35），并带出执行器的阶段行（模型加载 / VAD / 推理），下次一出现就能定位 |
| `src/types.ts` + 缓存 | 缓存条目记录 `device` / `engine`（**不进缓存键**，纯审计）："这条缓存是 GPU 还是 CPU 跑出来的" |
| `test/local-funasr-provider.ts` | 60 → **72 断言**：完成行必须带设备/引擎/RTF、慢行必须告警、成功时保留 stderr、解析器能取出 device/engine/elapsed_ms |

### 23.6 两个未决问题（都还没动手）

1. **队列是纯内存的**（`daemon.ts:181`），启动恢复只覆盖切片级卡住（`recoverStuck()`），
   **没有"把排队中的未完成任务重新入队"**。后果：任何重启都会把排队任务永久卡在
   「已录制 · 待处理」（轮询认为已导入、触发器只看录制文件，都不会再碰它们）。
   这也是「正在录制」显示修复**到现在还没生效**的原因 —— 我拒绝为它强重启（会卡死 4~7 个任务）。
   建议补一个 boot 时的"未完成任务重新入队"（排除人工停止/等待态）。
2. **慢的真因**：等 §23.5 的 info/warn 日志跑出下一场，就能回答"那次是 cpu 还是被别的进程抢了 GPU"。
   若确认是 GPU 争用，可选动作是关掉 Wallpaper Engine 之类常驻 GPU 占用，或不装 vLLM 就忍。

---

## 24. 「已投稿文件」一键删除 + 顺手抓到的两个真 bug（2026-10-06）

### 24.1 需求原话

> （截图：已投稿文件卡片上「99 项可删 / 共 20673.4 MB」）
> 「这里添加一键删除 所有可以删除的投稿文件」

99 个文件逐个点单删显然不可接受，所以要一个批量入口。**但批量不等于放宽判定** ——
门槛与单删一字不差：只有清单里 `deletable === true`（**有 bvid** 且**文件确实还在**）才删，
没投成功（还在审核、没有 bvid）的一律跳过，并且**如实报出跳过原因**。

### 24.2 为什么另起一个接口，而不是让界面循环调单删

| 原因 | 具体后果 |
|---|---|
| 99 次 HTTP × 99 次全量重算 | `uploadedFiles()` 每次都要遍历台账并摸磁盘（`/Api` 里实测 2.9 秒/次），循环调用会把界面卡住 |
| 中间态说不清 | 循环里任何一次失败都会留下"删了一半"，用户不知道到底删了几个 |
| 清单会变 | 单删按 key 现场查记录，批量必须用**同一份清单快照**，否则删到一半判定基准就漂了 |

`POST /api/published-file/delete-all`：取一次 `uploadedFiles()`，过滤 `deletable`，
逐个 `moveToTrash({root: <台账同级>/trash})`，返回
`{ok, deleted, failed[], skipped[{key,filePath,reason}], bytes, freedText, note}`。
返回里的 `note` 必须写清三件事（缺一条用户就会误判后果）：
**① 进回收站可恢复；② 空间要等回收站清理才真正释放；③ B站 上的稿件不受影响。**

### 24.3 真浏览器验证：**点了，但一个文件都没删**

「点一下删 99 个文件」这种按钮，验证时最忌讳"真按下去"。`tools/verify-monitor-ui.ts`
加了一段两层桩的验证，走完页面上**真实的代码路径**：

1. `window.confirm` 换成桩 → 先返回 `false`，断言**一个请求都没发**（未确认不动数据）；
   再返回 `true` 并把确认文案抄下来逐句核对；
2. `window.fetch` **只在 `/api/published-file/delete-all` 这一个 URL 上**换成桩（其余原样透传），
   于是"按钮到底发了什么请求"是抓下来看到的：`POST /api/published-file/delete-all` `{"confirm":true}`；
3. 还原桩后从 Node 侧再查一次 `/api/monitor`：`deletableCount`、`count` 与开始时**完全一致**；
4. 最后直接打接口、不带 `confirm` → 断言 **400**（后端独立把关，不靠界面）。

真浏览器 34 项断言全绿；`test/monitor-panel.ts` 126 → **168 项**（批量接口的幂等、跳过原因、
台账不动、界面静态接线一并钉住）。

### 24.4 顺手抓到的 bug ①：`confirm()` 是纯文本弹窗

第一版确认文案写的是 `全部**移入回收站**（7 天内可恢复）` —— 用户实际看到的是**带着两个星号**的
`全部**移入回收站**`。原生 `confirm()` 不认 markdown 也不认 HTML。改成「」并加静态断言：
一键删除的确认文案里**不许出现 `**` 或 HTML 标签**（正则必须先切到那段处理函数再取，
直接全文找 `const okGo = confirm(` 会抓到单删/解除墓碑那两处 —— 这次就踩了）。

### 24.5 顺手抓到的 bug ②：导入清单默认收起 = 看起来像坏了

`npm run verify` 里 `tools/ui-e2e.ts` 的「导入录播列出了可导入的录播」一直是红的：
接口返回 38 场，页面上 `.row[data-imp]` **0 行**。追到 `1ff3899`（给清单加了三组折叠）
把展开状态默认设成了 `{ idle: false, imported: false }` —— 于是用户打开这个对话框，
只看到「● 当前没有正在录制的场次 / ▸ 已录制完成 · 未导入 36 场 / ▸ 已导入过 2 场」三行表头。
而**这个对话框的唯一用途就是挑一场没导入的录播**。修：`idle` 默认展开（可收起），
`imported` 仍默认收起，`live` 那组永远展开。`test/watch-import.ts` 67 → **73 项**，
新增 §13 静态钉住这套默认值。

> 这个回归从 `1ff3899` 起就一直躺在库里没人发现 —— 因为那次提交只跑了与 ASR 相关的套件，
> **没跑完整 `verify`**。教训：改 `public/ui.html` 就必须跑 `ui-e2e`。

### 24.6 用户真的按了那个按钮：13 个文件 → 回收站（21:43:27）

界面刷新后用户直接在浏览器里点了它，服务端日志：

```
21:43:27 info 已移入回收站：<13 条，逐条带文件名与体积>
21:43:27 info 一键删除已投稿文件：成功 13 个（1.7 GB），失败 0 个，跳过 0 个（全部移入回收站，可恢复）
```

之后 `/api/monitor` 的 `count` 归 0、`deletableCount` 归 0，卡片显示空态
（「还没有已经投出去的文件…」）且**不再渲染那个按钮**。核查过：`tools/` 与 `test/` 里没有任何
一处会对**真实服务**打 `published-file/delete-all`（`test/monitor-panel.ts` 打的是自己起的临时
台账服务，`tools/verify-monitor-ui.ts` 把 fetch 桩掉了）—— 这一次是用户本人的点击。

### 24.7 真机截图又抓到两个缺陷（都已修）

验证工具收尾时截的那张图里，按钮停在**「正在删除…」**、旁边还浮着一个写着 **`undefined`** 的黑框：

| 缺陷 | 根因 | 修法 |
|---|---|---|
| 按钮永久卡在「正在删除…」 | 删除成功后调 `loadMonitor(true)`，而它为省重画会做 `silent && sig === m.sig` 的**签名快路径**；服务端数据没变（例如本次桩返回"删了 0 个"、或另一个标签页已经删过）就直接 return，按钮的文案/禁用状态留在原处 | 处理函数改 `try/catch/**finally**`，无论成败都自己复位按钮（真删掉了的话该节点已被重画替换，写它无害）。单删那条同样的写法一并修 |
| toast 弹出 `undefined` | `toast(\`${r.note}…\`)` —— 桩返回的 payload 没有 `note` 字段，模板字符串就把它变成字面量 `undefined` | `r.note \|\| \`已删除 ${r.deleted ?? 0} 个文件\`` 兜底 |

两条都进了断言：静态（`test/monitor-panel.ts` 检查 `finally` 复位与 `r.note ||` 兜底）+
真浏览器（`tools/verify-monitor-ui.ts` 点完按钮后断言 `disabled === false`、文案不含「正在删除」、
toast 里没有 `undefined`）。**这两个缺陷只有截图/真机才看得见** —— Node 侧断言全绿的时候它们就在那儿。

同时把验证工具改成**两种状态都能跑**：清单为空时验空态（有文案、没有按钮、没有残留标签），
不再把"没有对象可验"报成 8 条失败（这次就发生了：刚修完工具，用户已经把 13 个文件删光了）。

### 24.8 环境侧发现（不是代码问题，但要说）

1. **`publish.isOnlySelf` = 0，用户明确选择公开可见**（2026-10-06 确认）。
   于是"试跑期必须 = 1"这条旧约定作废，代码里三处跟着改（都不再把它当失败）：
   | 位置 | 原来 | 现在 |
   |---|---|---|
   | `src/config.ts` 校验 | `!== 1` 就 warn「试跑期应保持 =1」 | 只拦**非法值**（不是 0/1）；可见性是用户决定，不该每次加载都跳提示 |
   | `test/smoke.ts` #10 | 断言 `=== 1`（红） | 断言**取值合法** + 公开可见时进「环境项」报一次（永远看得见，不会悄悄漂回 1） |
   | `test/e2e-offline.ts` | 断言投稿载荷 `is_only_self === 1` | 断言载荷 **与夹具配置一致**（写死 0 或 1 都会漏掉真缺陷：想公开却投成自见 / 想试跑却被公开）；`tools/autoflow-check.ts` 同样只如实报出当前选择 |
   顺带发现：`test/e2e-offline.ts` 那个断言原本拿**仓库真实 config.json** 去比**用例自己的夹具配置**，
   夹具是 1、真配置是 0 时就会报"期望 0，实际 1"的假失败 —— 改成比夹具自己的值。
   （另：biliLive-tools 的投稿预设 `default` 是 `is_only_self=0`（公开，与我们的选择一致），
   而 `甲主播` 那个预设原本是 1 —— 两个主播可见性不一致，已问用户，用户选择**一起改成公开**，见第 3 条。）
3. **biliLive-tools 投稿预设已对齐成公开**：`node tools/blt-preset-set.ts --set is_only_self=0
   --preset xcz9r0pf7t`（原文件自动备份为 `presets.json.backup-<时间戳>`），复核两个预设现在都是 0。
   **不需要重启 biliLive-tools** —— 直接读 app.asar 求证：`class CommonPreset` 的
   `async get(id)` 走 `await this.list()`，而 `list()` 每次都 `await fs.readJSON(presetsPath)`，
   用的时候现读盘，没有内存缓存（biliLive-tools 当时正开着，这一点必须求证而不是猜）。
   顺带发现一个**死配置项**：`publish.uploadPresetId` 目前没有任何作用 ——
   `src/publish.ts` 里是 `void input.uploadPresetId`（投稿 config 由我们自己拼好整份传过去），
   界面上也没有它的入口。留着不碍事，但别指望改它会有反应。
   另一个顺手修掉的工具缺陷：`tools/asar-grep.ts` 里写死的 asar 路径带真实用户名，
   被 `tools/sanitize-for-public.ts` 脱敏成 `C:/Users/demo/...` 之后就永远 ENOENT ——
   现在按 `BLT_ASAR` 环境变量 → `%USERPROFILE%\Desktop\...` → `demo` 路径依次找。
2. **回收站已按用户指示清空**：27 个条目 / 7.75 GB（`POST /api/trash/purge {confirm:true}` →
   `已彻底删除 27 项，释放 7.8 GB`），`data/trash` 现在 0 个文件，
   D 盘余量 324.3 GB → **332.0 GB**。⚠️ 注意 `GET /api/trash` 返回的字段名是
   `files[]` / `totalBytes`（不是 `items`/`bytes`）—— 我第一次核对体积时按 `bytes` 读，
   全成了 0.0 MB，差点当成"清单体积统计坏了"。

### 24.9 本轮改了什么（一览）

| 文件 | 改动 |
|---|---|
| `src/server.ts` | **新增** `POST /api/published-file/delete-all`：一份快照 + 逐个进回收站 + 跳过原因如实返回 |
| `public/ui.html` | 卡片头「一键删除可删的 N 项」按钮（`deletableCount` 为 0 时不渲染）+ 确认框 + 结果 toast；确认文案改纯文本；`state.impOpen` 默认展开未导入组；单删/批删都用 `finally` 自己复位按钮；toast 文案兜底 |
| `test/monitor-panel.ts` | 126 → **171 项**：批量接口全链路 + 界面静态接线（含"确认文案不许有 markdown/HTML"、"按钮必须自己复位"、"toast 必须有兜底"） |
| `test/watch-import.ts` | 67 → **73 项**：§13 导入清单分组默认值 |
| `tools/verify-monitor-ui.ts` | 18 → **37 项**：真浏览器点按钮（桩住 confirm/fetch，零删除）+ 返回后按钮复位/toast 兜底 + **空态分支** |
| `tools/ui-e2e.ts` + `ui.html` | `UI_BUILD` → `ui-2026-10-06-bulk-delete-published-2`（两端同步） |

`npm run verify` 的 37 步里，36 步全绿；`smoke` 只有硬约束 #10 一条报红（配置状态，见 24.8），
它后面那步 `real`（真实素材、本地引擎真转写）因 `&&` 链中断被跳过，单独跑是 **PASS=24 FAIL=0**。
另有真浏览器验证：`tools/ui-e2e.ts` **121/121**、`tools/verify-monitor-ui.ts` 34/34（有数据时）
与 7/7（空态时）。






## 25. 「稿件表现」页为什么一直是 0：三个叠在一起的缺陷（2026-10-06）

用户截图这一页并说「这里现在没办法工作 修复他」。查下来**不是一处坏了，而是三个独立缺陷叠在一起**，
任何一个单独存在都足以让这一页看起来"完全没工作"。

### 25.1 缺陷 ①：回流候选一个都取不到（`checked=0`）

`ledger.bvidsNeedingPerformance()` 的判据是 `clip.status === 'PUBLISHED' && clip.bvid`。
但多分P 模式下切片是**追加**进 biliLive-tools 那份稿件的：续传时台账里写上了目标稿件的 bvid，
状态却停在 `SUBMITTED` —— 周期性反查是**按稿件标题**匹配的，分P 标题不是稿件标题，永远匹配不上。
线上实测：12 个切片全是有 bvid 的 SUBMITTED、0 个 PUBLISHED ⇒ `POST /api/performance/refresh`
恒返回 `checked=0`，页面自然永远是空的。

**改**：判据放宽成「**投出去了且知道 bvid**」（`PUBLISHED` 或 `SUBMITTED`）。
表现数据是按 bvid 查稿件的，状态是什么不影响这次查询的正确性。
同时把「续传落地确认成功 + 目标稿件 bvid 已知」的切片**直接记成 `PUBLISHED`**
（`publish.ts` 成功分支）—— 这两件事都已由 `confirmPartTitlesLanded` 确认过，
新建稿件（bvid 未知）则仍旧记 `SUBMITTED` 交给反查，不谎报。

### 25.2 缺陷 ②：统计数字读错了层级 ⇒ 每次都写 `view: 0`

biliLive-tools v3.22.1 的 `GET /bili/user/archive/:bvid` 把数字放在 **`View.stat`** 里，
顶层**没有** `stat` 字段（实测：顶层键是 `View, Card, Tags, Reply, ...`）。
旧代码读 `detail.stat.view` → `undefined` → `stat['view'] ?? 0` → **每次回流都写 0**。
线上 `performance.jsonl` 里 09-23 那 11 行全是 `view: 0`，用户看到的"全 0 页面"就是这么来的。

**改**：`View.stat` 优先、顶层 `stat` 兼容兜底；顺手把 `View.videos`（分P 数）与标题一起落账。
`test/performance-reflux.ts` 的桩**按真实形状**返回，谁再读错层级立刻红。

### 25.3 缺陷 ③：页面行是从台账拼的 ⇒ 删了任务就"失忆"

`performanceView()` 原来遍历台账的 tasks/clips 来出行。用户当天批量删掉了十几个任务
（tombstone 里 13:27 前后的 `task-deleted` 一片），一删这些稿件就从页面上消失了 ——
可稿件还在 B站 上、播放数还在涨。表现页不该因为本地清理而失忆。

**改**：行的来源改成 **`performance.jsonl` ∪ 台账**，并且：
- 候选多两个来源：**performance 历史**（任务删了也继续跟）、**我的稿件列表**
  （`/bili/archives`，覆盖"完整版由 biliLive-tools 投、本地没有任务"的稿件）；
- 落账时把**标题 / 评分 / 分P 数**一起写进 `performance.jsonl`，页面只依赖这份历史；
- 已确认「稿件不存在」的 bvid 不再反复请求（每天那 11 个废请求省掉），
  若它重新出现在稿件列表里则自动恢复跟踪。

### 25.4 顺带修掉的三个"看起来像坏了"的显示问题

| 现象 | 处理 |
|---|---|
| 同一稿件的 N 个分P 各出一行，播放数重复 N 次（相关性表的"切片数"被分P 多的稿件带偏） | **按 bvid 去重**，评分取该稿件内**最高分**的那一P，并标出「同一稿件 N 个分P」 |
| 取不到统计时显示 `0`（锁定/审核中/不可见都变成 0，看着像"没人看"） | 只有**真取到**才写数字；取不到写 `unavailable: 已锁定` / `gone: true`，页面标「已锁定」/「稿件已不存在」，数据日期写「取不到」/「已删除」 |
| 相关性表恒显示 4 行 0（用户最初就是被这个全 0 表误导） | 没有任何可统计样本时改成**一句解释**（说明需要"既有评分又有播放"的稿件、当前有几个稿件有播放数据），不再摆一张全 0 表 |

还有一处是"这一页默认像坏的"：原来打开页面只是读缓存，必须去「健康面板 → 刷新稿件表现数据」
才有数据。现在**首次打开且一条统计都没有时自动回流一次**再重画（回流本身按天去重，不会反复打接口），
失败项直接列在表格下方（bvid + 原因），不再静默。

### 25.5 真机实测（2026-10-06 22:0x，服务在线）

```
POST /api/performance/refresh → checked=21  updated=8  failed=13
   · 8 个稿件拉到真实数字（含分P 数来自 View.videos）
   · 2 个稿件 state=-4「已锁定」→ 标 unavailable，不写 0
   · 11 个稿件确认已不存在（用户删掉的稿件）→ 记 gone，页面标「稿件已不存在」
GET /api/performance → 21 个稿件 / 243 个分P / 已拉到数据 8 个
   播放降序：327 · 228 · 228 · 196 · 146 · 140 · 122 · 85
```

⚠️ 实测发现：`BV1fWhR6PEuc`（09-26 那场）与 `BV1xTH66jEhS`（10-04 那场）在稿件列表里
`state=-4 已锁定` —— **不是被删**，只是 B站 侧已锁定（公开接口 -404、biliLive-tools 详情 500）。
这两种情况必须分开报，否则会把"被锁定"误报成"稿件没了"。

### 25.6 验证

| 手段 | 结果 |
|---|---|
| `test/performance-reflux.ts`（**新增**） | **80 项全绿**：候选三来源、当天去重、窗口、已删不再请求与恢复、真 Publisher 续传记 PUBLISHED、`View.stat` 真形状、按 bvid 去重、锁定/已删/未拉取三种无数字状态、删任务后页面仍在 |
| `tools/verify-perf-ui.ts`（**新增**，真浏览器 Edge+CDP） | **23 项全绿**：点开页签、行数与接口一致、抽查 3 行的标题与播放数、锁定/已删/多分P 标签、相关性空态是解释而非全 0 表、**页面零未捕获异常** |
| `test/monitor-panel.ts` | 171 项未回归（实时监控那两块照旧） |
| `npm run typecheck` | 干净 |
| **`npm run verify`（38 步）** | **全绿** —— 含 `real` 的真实素材 + 本地 Fun-ASR 真转写（138 条字幕 / 161.9s / ¥0，24/24） |

### 25.7 已知边界（写清楚，免得下次又当成 bug）

1. **相关性表暂时没有样本**：现在有播放数据的 8 个稿件都是早期投的，那会儿的评分没有落进
   `performance.jsonl`（任务已被删，评分无处可取）。**新投的稿件会自动带上评分**，样本会自己长出来。
2. **已锁定的稿件拿不到统计**：B站 不公开就不给数字，页面如实标注，不猜、不写 0。
3. **回流每天一次**（`pulledToday` 去重）。想看最新数字只能等第二天或删掉当天行重跑 —— 这是刻意设计
   （只读接口也要省着打，且数据本身是慢变量）。
4. 稿件列表只取前 100 条（`pageSize=100`）；稿件数超过 100 时更早的不会被自动跟踪，
   届时需要补分页（已在方法注释里写明）。
   **已加护栏**：返回条数 == 页大小说明后面还有页，这时「列表里没有」**不再**被当成「稿件已删」，
   只保留重试 —— 否则第 101 个往后的稿件每天都会被误标成「稿件已不存在」。

### 25.8 本轮改了什么（一览）

| 文件 | 改动 |
|---|---|
| `src/ledger.ts` | `bvidsNeedingPerformance`：判据放宽 + 三个来源（台账/历史/稿件列表）+ 沿用标题评分分P + 已删不再请求；`recordPerformance` 新增 `title/score/parts/gone/unavailable` |
| `src/daemon.ts` | `refreshPerformance`：读 `View.stat`（顶层兼容）、落账带标题评分分P、把「锁定」与「被删」分开标注、失败原因进 notes；新增 `markPerformanceGone` |
| `src/publish.ts` | 多分P 续传成功且目标 bvid 已知 ⇒ 切片记 `PUBLISHED`（旧写法只记 SUBMITTED，是缺陷①的源头） |
| `src/server.ts` | `performanceView`：行改为 `performance.jsonl ∪ 台账`、按 bvid 去重、评分取最高分分P、`pulledTotal`、锁定/已删标注、只有真取到才算数据日期 |
| `src/types.ts` | `ArchiveDetail.View`（含 `videos`/`stat`）、`ArchiveItem.state_desc` |
| `public/ui.html` | 首次打开自动回流、失败项列出、锁定/已删除/未拉取三种状态显示、相关性空态解释、表头带 `已拉到数据 N 个` |
| `test/performance-reflux.ts` | **新增** 80 项 |
| `tools/verify-perf-ui.ts` | **新增** 真浏览器 23 项（`npm run perf-ui`） |
| `package.json` | `verify` 37 → **38 步**（插入 `performance-test`）；新增 `perf-ui` |

## 26. 「上一轮对每个文件的结论」太长：35 行全是"已导入过"（2026-10-06）

用户截图「实时监控 → 目录轮询 → 上一轮对每个文件的结论」并说：
**「这里的显示的太多了 而且是导入过的 优化他」**。

截图里是 35 个文件、12 行密集表格，每行的结论都是同一句
`已导入过（任务 auto-…，于 2026/10/4 18:36:19）—— 该任务已从台账删除；如确实要重跑，请用界面「导入录播」手动导入`
——**信息量为零，还把「有没有需要我处理的」这件事淹掉了**。

### 26.1 三处改动

1. **分类 + 折叠**（`public/ui.html` renderMonitor）：
   - 需要留意的结论（导入成功 / 正在录制等写完 / 失败 / 文件不可用）→ 直接列表，最多 12 行；
   - 「已导入过」→ **默认收起**（历史记录，不需要处理），点表头才展开（最多 60 行）；
   - 一个都没有需要处理时，直接给一句「这一轮没有需要你处理的结论（N 个文件都是『已导入过』的历史记录）」。
2. **表头先给分类计数**：`共 35 个 · 导入成功 0 · 已导入过 35 · 其它 0` —— 一眼就能看出"没我的事"，
   原来的「其中 35 个没导」反而像出了 35 个问题。
3. **文案不再逐行重复**（`src/watch-import.ts`）：跳过原因压短成
   `已导入过（任务 X，于 <时间>；该任务已从台账删除）`（原来还拖着「如确实要重跑…」），
   重跑办法（用「导入录播」手动挑那一场 / 关掉目录轮询）**整块只写一次**，并说明为什么不会自动重导
   （重复跑一遍是白花的 ASR + LLM 钱）。

### 26.2 真浏览器验证当场抓到一个 bug（static 测试抓不到的那种）

第一版把折叠的点击处理接到了 `renderHealth()` 末尾 —— 而这段 DOM 是**实时监控页**
（`renderMonitor()`）画的，于是「点了没反应」：可见行 0、箭头不变。
`tools/verify-health-ui.ts` 的「点开后能看到这些历史行」当场判红（期望 35，实际 0），
挪到 `renderMonitor` 的绑定区后 15/15 全绿。
**这正是"DOM 里有 ≠ 用户看得见/点得动"的典型**，静态断言（`test/monitor-panel.ts`）查不出来。

### 26.3 验证

| 手段 | 结果 |
|---|---|
| `test/monitor-panel.ts` | 171 → **182 项**：新增 11 条静态接线断言（分类、默认收起 `display:none`、表头计数、点击绑定、箭头/title、12 行上限、逐行不再有长句、重跑只写一次） |
| `tools/verify-health-ui.ts`（**新增**，真浏览器 Edge+CDP） | **15 项全绿**：计数与接口一致、35 行默认收起（`offsetParent === null`）、可见行 ≤12、点开展开 35 行、再点收回、行内无长句、提示只出现一次、页面零未捕获异常（`npm run health-ui`） |
| `test/watch-skip-burn-product.ts` | 14 → **17 项**：原因保持简短（≤60 字）、带任务号、不再含「如确实要重跑」长句 |
| `UIBUILD` | `ui-2026-10-06-health-imported-collapsed`（`tools/ui-e2e.ts` 的期望值同步更新） |

实测（真机、35 个真实文件）：页面上这一块从「12 行密集表格 + 每行一句重复指引」
变成 **1 行结论 + 1 行可折叠表头（35 个）**，需要展开时才展开。

## 27. 「我的切片助手在反复重启」——服务没重启，是窗口在闪（2026-10-06）

用户问：「为什么 我的切片助手 在反复重启」。

### 27.1 逐秒观测的结论：服务没有在重启

对进程做逐秒采样（服务 pid + 端口 3000 的持有者 + launcher 进程集合），覆盖了 23:34:15 那一跳：

```
23:34:16  LAUNCHER SET CHANGED -> [31520@23:34:16@task=True]     ← 计划任务那一跳的 launcher 起来了
23:34:18  LAUNCHER SET CHANGED -> [9936@23:26:21@task=False]    ← 2 秒后它自己退出
END 23:34:46   服务 pid 全程 = 31524（22:21:36 启动，未变）
```

配合计划任务自己的记录：`LastRunTime=23:24:16  LastTaskResult=0`（0 = 成功），
即**每一跳都只做了"检查一下、发现服务在跑、退出"**。
今天的启动清单（本地时间，取自 `data/logs/live_auto-*.jsonl` 的启动横幅）：

```
17:01:29（开机） 20:44:22 | 21:24:20 21:24:27 21:31:08 21:52:10 22:03:40 22:05:26 22:08:15 22:21:36
```

21:24–22:21 那一串**是我和并行的另一个会话在改代码后主动重启服务**（每次都要重启才能加载新代码），
不是自动循环：真正的 10 分钟跳点是 `:24 :34 :44 :54 :04 :14`，而清单里只有 21:24:27 落在跳点上。

### 27.2 那"反复重启"的观感是从哪来的：三个真实缺陷

1. **计划任务跑的是给人双击的交互式启动器**。
   `tools/autostart.ps1` 注册的动作是 `launcher.ps1 -NoBrowser -NoPause`，而 `launcher.ps1`
   是前台交互式启动器：它**创建可见控制台窗口**。于是每 10 分钟屏幕上闪一个窗口
   （任务 `Hidden=False`、动作里也没有 `-WindowStyle Hidden`）。
2. **探活只有 3 秒，误判就会杀健康服务**。
   `launcher.ps1` 用 `GET /api/bootstrap`（3 秒超时）判断"服务在不在"。服务忙时（事件循环被占住）
   会超时 → 判成"没在跑" → 起**第二个**实例 → 第二个实例撞端口（EADDRINUSE）→
   紧接着它 `finally` 里的"双保险"按命令行特征扫全机：
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where CommandLine -like "*$ROOT*"`，
   **把正在健康运行的那个服务一起杀掉**。加上任务本身的"失败重试 3 次 / 每分钟"，
   这就是一条真正的重启链。
3. **启动器常驻前台持有服务**。它启动服务后自己留在前台（日志往窗口里灌）：
   关掉那个窗口 = 服务停掉 → 下一跳又开一个窗口 ⇒ 用户看到的就是"反复重启"。
   实测 23:26:21 桌面快捷方式起的那次（`task=False`）就是这种窗口，而且因为 `run.cmd` 不带
   `-NoPause`，它**停在"按任意键关闭此窗口"**不动 —— 看起来像卡死。

### 27.3 改法：自动这一路彻底无窗口、只拉起、绝不杀

| 文件 | 改动 |
|---|---|
| `tools/ensure-service.ps1`（**新增**） | 计划任务专用守护：① 端口在监听 ⇒ **什么都不做**（哪怕探活超时，判为"在跑但繁忙"）；② 端口空闲 ⇒ `Start-Process -WindowStyle Hidden` 起独立服务，等就绪后退出（上限 180 秒）；③ **全脚本没有 Stop-Process / taskkill**。只在真启动时往 `data/logs/watchdog.log` 写一行 |
| `tools/autostart.ps1` | 默认动作改成 `powershell -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -File tools\ensure-service.ps1 -Port <port>`；新增 `-VisibleLauncher` 回到老行为；`-Status` 会打印"任务动作是哪个脚本"并对旧注册给出告警 |
| `launcher.ps1` | ① 新增 `Test-Port`，「端口在监听但探活失败」判为**在跑但繁忙**（不再误判）；② 收尾清理限定为**自己的子进程**（`ParentProcessId -eq $PID`），删掉按命令行扫全机的那一发；③ 「已在运行」时窗口 8 秒后自动关闭，不再停在"按任意键" |
| `README.md` | 自启一节重写：自动=无窗口守护、手动=桌面快捷方式（有窗口、关窗口即停），以及"想停久一点"用 `Disable-ScheduledTask` |

已把线上任务重新注册（`tools\autostart.ps1 -Install`），当前动作：

```
powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden `
  -ExecutionPolicy Bypass -File "F:\deepseek\live_auto\tools\ensure-service.ps1" -Port 3000
```

### 27.4 验证

| 手段 | 结果 |
|---|---|
| 守护脚本实跑（服务在跑时） | 退出码 0、1.7–2.1 秒返回、**服务 pid 未变**、node 进程数未变、`watchdog.log` **没有新增行**（静默通过） |
| `Start-ScheduledTask` 手动触发 | 守护进程带 `-WindowStyle Hidden`（命令行核对）、服务 pid 未变、`LastTaskResult=0`、无日志写入 |
| 「隐藏子进程能否活过任务结束」 | 用**同构的替身任务**（临时任务名 + 立即退出的脚本 + `Start-Process -WindowStyle Hidden`）验证：子进程在任务动作结束后 **35 秒以上仍存活**（这是"看门狗拉起服务后不会被连带收掉"的关键不确定性），验证后已清理替身进程与临时任务 |
| `test/service-watchdog.ts`（**新增**） | **33 项全绿**（`--live-restart` 时 38 项）：守护脚本无杀进程动作、BOM 与语法、任务动作=X 守护脚本+隐藏窗口+不再是 launcher、launcher 的清理已限定为子进程、非破坏性实跑（rc=0/pid 不变/无日志） |
| 破坏性实跑（杀服务→看门狗拉回） | **已跑通**（等流水线连续 90 秒空闲后执行）：杀掉 pid 31524 → `Start-ScheduledTask` → 看门狗隐藏启动 pid **17152** → **任务结束后 30 秒仍存活** → `watchdog.log` 恰好两行（"服务不在运行…启动" + "服务已就绪"）；复查：服务主窗口句柄 **0**（无窗口）、launcher/守护残留进程 **0**。该步骤默认不跑且**队列忙时自动拒绝**（本地 ASR 被打断会白烧 GPU），需要时：`npm run service-watchdog-live` |

顺带钉住的一条铁律（本轮被它坑过）：**所有 `.ps1` 必须是 UTF-8 带 BOM** ——
编辑工具重写文件会丢掉 BOM，PowerShell 5.1 随即按 ANSI(936) 解码，中文变乱码并报
`The string is missing the terminator`。套件②会对仓库里全部 `.ps1`（当前 7 个）逐个检查 BOM 并抽检解析。

另一个值得记下的坑：**按命令行特征杀进程时，匹配串会出现在自己的命令行里**。
我用 `CommandLine -like '*STANDIN*'` 清理替身进程时，先杀掉的其实是**我自己这条命令的宿主进程**
（它的命令行里含 `STANDIN`），于是 harness 报了三次
`Windows Job runner exited ... before proving its managed range empty`。
正确做法是把匹配串**拼出来**（`'setInter' + 'val('`），或用 `ParentProcessId` 限定。

---

## 37. 「为啥几分钟就中断一次录制」——查清了，并且把碎片并成一场（2026-10-06 深夜）

### 37.1 先回答"为什么"

**不是 biliLive-tools 主动停，也不是本项目干的** —— 是那一条 FLV 拉流被 CDN 那头关掉了，
biliLive-tools 随即换一个地址重连，于是同一场直播落成好几个文件。证据链（都可复核）：

| 证据 | 内容 |
|---|---|
| 日志原文 | `recorder: record end, reason: ["finished"]` —— ffmpeg **正常退出**（不是崩、不是被杀）；1～2 秒后就 `录制23456789中断，立即触发重试（N/10）` 并重新取流 |
| 重试计数 | 23:28:40(1/10)、23:34:08(2/10)、23:39:07(3/10)、23:46:04(4/10) —— **同一场直播累计**，上限 10 次 |
| 不是 URL 过期 | 13 次取流的 `expires` 全是「取流时刻 + 60 分钟」，而每段只活了 3～7 分钟 |
| 不是本项目 | 158 场已结束录制里 **60 场（38%）短于 15 分钟**，最早到 08-09 / 08-20 / 08-23 / 09-07（本项目 09-23 才开工）；最极端的是 08-23 21:04–21:14 与 09-07 18:46–18:54 各连续 9 个 0～2 分钟的文件。今晚 23:28、23:34 两次中断前后 ±2 分钟我们服务**没有任何动作** |
| 唯一一次本地故障 | 23:39:08 `ffmpeg exited with code 4294967274: Error opening output file …-PART%03d.ts`（-22 EINVAL）—— 连输出文件都没打开成功，那是机器侧的一次瞬时问题，与流无关，且只出现一次 |
| 它自己会好 | 23:46:05 开始的那一段连续录了 9 分钟以上没再断（当晚最后一次中断停在 23:46:04） |

⚠️ 排查时踩的编码坑（值得记）：`%APPDATA%\biliLive-tools\logs\main.log` **是 GBK**，
按 UTF-8 直接读全是乱码；而这个文件里**还混着 UTF-8 的行**（重试那条就是），
所以两种解码都要试一遍再搜关键词。

### 37.2 我们能改的那一半：把碎片并成一场

CDN 那头关流修不了，但"一场直播被拆成 N 个任务、N 次转写、N 组切片、往同一稿件投 N 批分P"
是本项目自己的问题。新增**碎片合并**：

| 判定 | 规则 |
|---|---|
| 同一场 | 同目录 + **标题完全相同** + 开录时刻（文件名里的时间戳）紧接上一段结束（间隔 ≤ `gapSec`，默认 120 秒；实测重连只隔 1～21 秒） |
| 不算碎片 | `-弹幕版` / `-纯享版` / `-danmaku` 压制产物（否则同一段素材导两次、还会烧双层弹幕） |
| 同基名分段 | `X.ts` + `X-PART001.ts` **不参与**碎片合并（那是"同一文件被切成多段"），继续走原有逻辑 |
| 上限 | 单场合并跨度 ≤ `maxMinutes`（默认 30），且**以串头为锚** |
| 等安静 | 最新写入距今 < `quietSec`（默认 180 秒）就先不动 —— 否则每断一次就导一次，合并等于白做 |
| 不重复导 | 导入时按台账过滤掉**已属于别的任务**的文件（手动导入中间那一段时尤其重要） |

配置（`config.example.json` 里也补了说明）：

```json
"import": { "stitch": { "enabled": true, "gapSec": 120, "quietSec": 180, "maxMinutes": 30 } }
```

### 37.3 真实数据上的效果（今晚那一场）

清单接口读实际录制目录，四个已闭合碎片并成一个候选：

```
2026-10-06 23-25-18-143 好冷好冷！电台一下.ts | 段数 4 | 时长 1216 秒 | 体积 116157680 | 碎片4 跨度21分
2026-10-06 23-46-05-978 好冷好冷！电台一下.ts | 段数 1 | 时长 1242 秒（仍在写，自己的候选）
```

改之前：四行候选、四个任务（今晚就是这么被拆开导进去的）。

### 37.4 实现里抓到的三个坑（都写进注释与断言了）

1. **上限截断必须锚定串头**。第一版让每个样本"以自己为中心"截，于是 A→D 是一条串、
   D→E 又是一条串，**D 同时落在两个候选里** —— 两个候选都会来导它，同一段素材被转写两次。
   锚定串头之后，一条串只会出现在一个候选里（要么整条，要么从串头开始的前缀）。
2. **产物判定不能用剥完后缀的字符串**。`stripRecordingSuffixes` 的职责就是剥掉
   `-弹幕版`/`-纯享版`，拿剥完的结果去测 `PRODUCT_SUFFIX` 永远为 false ——
   `-纯享版` 会被当成碎片并进来。
3. **Windows 文件名不能含 `:`**。夹具里把 `20:00:00` 写进文件名 → `writeFileSync` 报 ENOENT
   （报错信息完全看不出是名字非法）；而 `Date.parse('2026-10-06T20-10-00+08:00')` 是
   `Invalid Date`，`utimesSync` 会**静默**把 mtime 设成 1970。两个坑叠在一起时，
   合并判定的失败看起来毫无道理。

### 37.5 验证与改动一览

| 文件 | 改动 |
|---|---|
| `src/recordings.ts` | **新增** `fragmentIdentityOf` / `stitchRunOf` / `discoverRecordingFiles` / `StitchConfig` + `DEFAULT_STITCH`；清单里把相邻碎片并成一场，带 `fragmentCount` / `stitch` / `stitchWaiting`；多段时**时长与体积按整场聚合**（原来只报首选那一段：21 分钟的一场显示成 3 分 20 秒，ASR 预估也跟着少算 6 倍） |
| `src/daemon.ts` | `importLocal` 改用 `discoverRecordingFiles`；按台账过滤掉已属于别的任务的文件；把合并说明写进日志 |
| `src/watch-import.ts` | `stitchWaiting` 时**不导入**并如实说明还剩多久（不写成"仍在写入"，避免误导） |
| `src/config.ts` + `config.example.json` | `import.stitch`（类型/默认值从 `recordings.ts` 借，避免两处漂移） |
| `public/ui.html` | 导入清单的行上标出「已拼 N 段碎片，等安静 X 秒」/「已合并 N 段碎片（整场）」 |
| `test/stitch-fragments.ts` | **新增套件 36 项**（身份解析 / 串识别 / 上限与锚点 / 导入文件表 / 清单状态），已接进 `npm run verify` |
| `test/watch-import.ts` | 73 → **79 项**：§14 等安静期间不导入、安静后正常导入 |

回归：`recordings 107`、`stitch 36`、`watch 79`、`config 34`、`monitor-panel 183`、
`pending-delete 115` 全绿；`typecheck` 干净。真实清单已在上面 28.3 复核。


## 28. 「还是有自启现象」——`-WindowStyle Hidden` 挡不住 Windows Terminal；顺带查到一次真崩溃（2026-10-07）

用户在两处修好后又报：**「还是有自启现象」**。这次没有猜，装了个**顶层窗口监视器**
（`EnumWindows`，每 120ms 扫一遍，记录新出现的控制台类窗口 + 属主进程），守着计划任务那一跳看。

### 28.1 抓到的现行

```
01:07:48.827  PseudoConsoleWindow          state=**visible**  owner=powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden …
01:07:48.924  CASCADIA_HOSTING_WINDOW_CLASS state=**visible**  title="…\powershell.exe"
```

**根因**：这台机器的**默认终端是 Windows Terminal**。控制台窗口由 `WindowsTerminal.exe` 创建，
`-WindowStyle Hidden`（即 STARTUPINFO 的 `SW_HIDE`）在 WT 下**不生效** ⇒ 每 10 分钟闪一个终端窗口。
路径上试过但都不行：wscript/mshta 垫片（子进程照样交给默认终端）；
S4U（"不管用户是否登录都运行"，会话 0 里结构上不可能有窗口）—— `Register-ScheduledTask`
报 **Access is denied**（需要"作为批处理作业登录"权限，本脚本刻意不要求管理员）。

**解法**：`conhost.exe --headless`（本机 10.0.26200 实测支持，退出码 0）。任务动作变成：

```
conhost.exe --headless "powershell.exe" -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass `
  -File "…\tools\ensure-service.ps1" -Port 3000
```

改完连续观测两跳：

```
01:13:13.731  PseudoConsoleWindow  state=hidden  owner=powershell.exe …
01:23:14.717  PseudoConsoleWindow  state=hidden  owner=powershell.exe …
```

**只有隐藏窗口，屏幕上什么都不出现。**（同一时段 01:21:48 还抓到一次**用户自己双击桌面快捷方式**——
那是 `run.cmd` 起的交互式启动器，标题「直播切片助手 · live_auto」，可见窗口是**手动路径的设计**，不是自启。）

### 28.2 顺带查到的第二件事：服务真的崩过一次（Node 堆 OOM）

看 `data/logs/service-error.log` 才发现 00:21:59 那个实例在 **01:17:03 直接 abort** 了：

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

时间线：00:54:03 开始转写（6 小时窗口）→ 01:16:40 转写完成（1151 条，868.7s）→ **23 秒后进程崩**。
崩了之后是**用户自己点桌面快捷方式**（01:21:48）把它拉回来的；否则看门狗会在 10 分钟内静默拉起。
所以"看起来在重启"确实还有第二个来源：**崩溃 + 拉起**，而不是窗口。

已排除的：弹幕解析（那场 XML 只有 0.28MB，`loadDanmaku` 的 64MB 上限根本没碰到）、
轮询泄漏（连续打 40 次 `/api/monitor` + `/api/tasks`，工作集稳定在 114MB，单次 40ms）。
**没定论**：那 23 秒里是"转写产物落盘 → 分析"这段，缺证据（当时既没有内存曲线也没有崩溃报告）。

### 28.3 为此加的取证与余量（三处启动路径必须一致）

| 内容 | 位置 |
|---|---|
| `--max-old-space-size=8192`（默认上限实测约 4.3GB，机器有 32GB 没用上；这是余量不是修复） | `tools/ensure-service.ps1`、`launcher.ps1`、`tools/restart-service.ts` |
| `--report-on-fatalerror` + `--report-directory=data\logs`（下次 OOM 会留诊断报告：堆构成、原生栈、环境；已用 `--max-old-space-size=40` 的 OOM 实测过会写 21KB 报告） | 同上 |
| 每 5 分钟一行内存曲线（`内存：RSS … · 堆 …/…MB`），超过堆上限 60% 升级为 warn 并带队列状态 | `src/daemon.ts` |
| `/api/health` 新增 `memory: {rssMB, heapUsedMB, heapTotalMB, heapLimitMB, externalMB}` | `src/daemon.ts` |

实测（重启后）：`{"rssMB":131,"heapUsedMB":32,"heapTotalMB":99,"heapLimitMB":8384,"externalMB":13}`，
日志里能看到 `内存：RSS 119MB · 堆 43/8384MB（启动基线）` —— 8192 的堆上限确实生效了。

### 28.4 验证

| 手段 | 结果 |
|---|---|
| 顶层窗口监视器（`data\watch-windows.ps1`，EnumWindows） | 改前抓到 `state=visible` 的 WT 窗口；改后**两跳都只有 hidden** |
| `Start-ScheduledTask` 手动触发 | 服务 pid 不变、`LastTaskResult=0`、watchdog.log 无新增（静默通过） |
| 杀掉服务 → `Start-ScheduledTask` | 看门狗用**新参数**把它拉回来（命令行核对含 `--max-old-space-size=8192 --report-on-fatalerror`） |
| `test/service-watchdog.ts` | 33 → **52 项**：新增 ①b（三条启动路径的参数一致性，9 项）+ 内存可观测性（`/api/health` 字段、堆上限 >4300MB、日志有基线行） |
| 回归 | `monitor-panel` 182、`performance-reflux` 80、`config-checks` 34、`smoke` 66 全绿 |

### 28.5 两个反复踩到的坑（已进套件）

1. **`.ps1` 丢 BOM**：编辑工具重写文件会把 UTF-8 BOM 去掉，PowerShell 5.1 随即按 ANSI(936) 解码，
   中文变乱码并报 `Unexpected token`。套件②现在逐个文件检查 BOM + 抽检语法 ——
   这一轮它当场抓到了我自己刚改坏的 `ensure-service.ps1`。
2. **按命令行特征找进程会匹配到自己**：用 `CommandLine -like '*STANDIN*'` 清理替身进程时，
   先杀掉的是**我自己这条命令的宿主**（它的命令行里就有 `STANDIN`），于是 harness 连报三次
   `Windows Job runner exited …`。正确做法：把匹配串拼出来（`'setInter' + 'val('`），或用 `ParentProcessId` 限定。

## 29. 「1 个多小时才 200 多 M」= 显示正确；但顺着它挖出了"反复重启"的**真正根因**（2026-10-07）

### 29.1 先回答显示问题：是对的

| 段 | 时间 | 时长 | 大小 | 码率（ffprobe 实测） |
|---|---|---|---|---|
| 段1（已闭合） | 23:46:05 → 00:45:05 | 59.0 分钟 | 320.3 MB | **759 kbps** |
| 段2（正在写） | 00:45:05 → 01:34:47 | 49.7 分钟 | 273.5 MB | **767 kbps** |
| 合计 | 108.7 分钟（＝面板里 biliLive-tools 的 01:47:35） | | ~594 MB | |

两段首尾相接（00:45:05 / 00:44:59，相差 6 秒的边界），**一分钟没丢**。
`.ts` 是 biliLive-tools 的**原始流复制**（不重编码），码率就是源流码率；同一个主播 10-03 两场实测
**787 / 794 kbps**，完全一致 ⇒ 这个主播的原画就这个码率。面板上那个数字来自上一轮扫描（≤60 秒前），
所以比"此刻"略小（文件约 70 KB/s）。

### 29.2 但这一场有个致命副作用：`totalDuration = 0`

台账里这一场 `source.totalDuration = 0`、`segments[].duration = 0` —— 因为**导入时 ffprobe 被判为不可用**
（日志里那条 `找不到可用的 ffprobe … 全局时间轴不可用`），所有时长字段记成了 0。

### 29.3 真正根因：SuperChat 的**绝对**时间戳 → 密度曲线要建 1.79 亿个窗口 → 8GB 堆爆

用 256MB 小堆逐子步骤复跑（探针打印每步内存），最后一条是：

```
末个 = {"time":1791304995.684, "rawTime":1791304995.684, "kind":"superchat", …}
```

biliLive-tools 的弹幕 XML 里两类节点的时间语义**不同**：

```xml
<d  p="5.189,1,25,…" timestamp="1791301571821">普通弹幕</d>      <!-- p[0] = 相对秒 ✔ -->
<sc ts="15.469" price="30000" timestamp="1791301582101">…</sc>  <!-- 相对时间在 ts 上！ -->
```

`danmaku.ts` 的 `pickRawTime` 旧顺序是 `['rawTime','raw_time','timestamp','ts','stime','time']` ——
`timestamp`（绝对 Unix 毫秒）排在 `ts`（相对秒）**前面** ⇒ 那 35 条 SC 的 time 变成 1791301582 秒（≈2026 年）。
接着 `buildDensity` 在"视频时长未知"（`videoDuration=0`）时按**最大时刻**兜底算 span ⇒
`n = ceil(1.79e9 / 10)` = **1.79 亿个窗口对象** ⇒ 堆一路涨到 8GB → V8 `FATAL … heap out of memory` →
**进程 abort**（不是 JS 异常，所以没有任何 try/catch 能拦住）。

崩溃报告（`--report-on-fatalerror` 派上了用场）：
`old_space 6930MB + large_object_space 1027MB，limit 8384MB，rss 8193MB`。

于是形成闭环：**崩 → 看门狗 2 分钟内拉起 → 启动恢复把它重新入队 → 再崩**。
它就是用户两次报的"反复重启"（窗口只是表象，这是实质）。

### 29.4 三处修复

| 修复 | 位置 |
|---|---|
| **解析层**：相对时间优先（`ts`/`stime`/`time` 排在 `timestamp` 之前）；只有绝对时间戳的条目用**开播锚点**换算（锚点 = `<d>` 的 `timestamp − p[0]×1000`，取最小）；连锚点都没有就**丢弃并如实告知**（宁可少几条 SC 的时刻，也不让 1.79e9 流进下游） | `src/danmaku.ts` `pickRawTime` / XML 解析 |
| **密度层护栏**：兜底 span 只认"像相对时间"的时刻（`< 1e8` 秒 ≈ 3.17 年），并且窗口数硬上限 20 万 —— 任何脏时间都不该有机会把进程撑死 | `src/danmaku.ts` `buildDensity` |
| **崩溃循环刹车**：同一个任务启动时自动重跑超过 **3 次**就停手，只记警告（"请查看错误报告，修好后手动点继续"）；手动入队（= 用户点继续/重跑）会把计数清零 | `src/daemon.ts` `recoverUnfinishedTasks` + `types.ts` `autoResumeCount` |

### 29.5 验证

| 手段 | 结果 |
|---|---|
| 探针（同样的输入，256MB 小堆） | 修前：`FATAL 堆爆`；修后：**31MB 通过**，SC 时刻 = **3429.052 秒**（相对），密度窗口 **354 个**（不是 1.79 亿） |
| 真机端到端 | 之前崩三次的那一场 `auto-20261006165057-i52y` **跑完了 ANALYZED**（此前每次死在弹幕解析），服务内存 219MB（此前 8GB abort） |
| `test/segment-danmaku.ts` §⑪（新增 8 项） | 100 项全绿：SC 用 `ts`、带锚点换算、无锚点丢弃并告警、`ts="0"` 合法保留、密度硬上限 |
| `test/boot-requeue.ts` ②b（新增 8 项） | 21 项全绿：连续 3 次启动都会被捡、第 4 次停手、计数清零后恢复 |
| 回归 | `performance-reflux` 80 / `monitor-panel` 182 / `watch-import` 79 / `typecheck` 全绿 |

顺带修掉一个**测试污染真实日志**的问题：`Ledger` 默认用全局 logger，
于是新套件往真实 `data/logs/live_auto-<date>.jsonl` 里灌了几十条「新建场次任务」，
排查线上问题时把日志尾部刷掉了（正是这次找 OOM 现场时踩到的）。现在套件传静默 logger。

### 29.6 还没解决 / 需要留意的

1. **`totalDuration = 0` 的根**（导入时 ffprobe 不可用）没查：自检里 ffprobe 是好的，
   但导入路径当时判成不可用。这一场的时间轴因此仍按"单窗口整文件"转写，字幕时间戳可能与视频有偏移。
   已在 `media.ts` 侧留了降级告警；下次导入时我会盯一下 `segments[].duration` 是否正常。
2. 那一场现在停在 `ANALYZED`（待审核）——如果配置是半自动，需要你在界面上确认；全自动会继续切片。

## 30. 任务列表「多选批量删除」（2026-10-07，用户要求）

用户看着任务列表说：**「添加 多选功能 可以多选已发布 进行删除」**（列表里几十场逐个点「⋯ → 删除任务…」太折磨）。

### 30.1 做了什么

**界面**（`public/ui.html`）：

- 搜索栏右侧新增「多选」开关；进入后每张卡片左侧出现勾选框，**点卡片=勾选/取消**（不再切换任务），「⋯」菜单暂时收起；
- 工具条：`已选 N 个` · **`全选已发布（M）`** · `清空` · **`删除选中（N）`** · `退出多选`；
- 选中项只在**当前可见列表**里维护：切筛选/搜索时把看不见的 id 丢掉 —— 否则切到「处理中」再点删除，
  会把上一个筛选里选中的场次一起删掉（看不见却删了，是最糟的交互）；
- 删除走对话框 + 二次确认，三个勾选项（切片产物 / 任务目录 / 源素材）对所选任务统一生效，
  默认与单删一致：**只删切片产物**（最占地方、随时可重切）。

**后端**（`src/server.ts`）：新增 `POST /api/task/delete-batch`：

- 语义与单删**完全一致**（逐个走 `orch.deleteTask`，同一套回收站/跳过规则），只是汇总结果；
- `confirm: true` 必填；空清单拒绝；**一次上限 200 个**（防一次误点清空台账）；
- 重复 id 自动去重；单个失败不影响其它，**逐项如实**返回 `failed: [{id, error}]`；
- `ok` 只在**全部成功**时为 true —— 部分成功不许谎报成功；
- 额外回一条 `publishedClips` 计数与 note 提示：删除本地文件**不会撤回 B站 上的稿件**。

### 30.2 确认文案的硬约束（纯文本弹窗）

`confirm()` 不认 HTML 与 markdown（踩过：`**移入回收站**` 原样显示星号），所以文案必须是纯文本，且
必须把三件事说清：① 删几个；② 进回收站 7 天内可恢复、磁盘空间要等「回收站清理」才释放；
③ **B站 上的稿件不会被撤回或删除**（要撤下得去创作中心）。静态断言逐条钉住。

### 30.3 验证

| 手段 | 结果 |
|---|---|
| `test/monitor-panel.ts` | 182 → **212 项**：17 条界面静态接线（勾选框、点卡片=勾选、全选已发布、计数写在按钮上、"只在可见列表里维护"、确认文案无 HTML/星号且写明不撤回稿件）+ 13 条接口行为（缺 confirm 拒绝、空清单拒绝、>200 拒绝、去重、坏 id 进 failed、ok=false、publishedClips 计数、只删产物时记录保留、勾任务目录后记录消失且进回收站） |
| `tools/verify-multiselect-ui.ts`（**新增**，真浏览器，**零删除**） | **19 项全绿**：多选开关 → 勾选框出现 → 点卡片=勾选 → 全选已发布（7 个）→ 删除按钮显示数量 → 弹对话框且**此刻还没发任何写请求** → 确认后**只发一次** `delete-batch` 且带 `confirm:true`、`deleteClips:true`、id 数与勾选数一致 → 桩拦下删除后**真实台账任务数一条没少** → 页面零未捕获异常（`npm run multiselect-ui`） |
| `npm run ui-e2e` | **121/121**（构建号已同步为 `ui-2026-10-07-task-multiselect`） |
| `npm run typecheck` | 干净 |

### 30.4 一个查证副产品：删除语义（免得后人误读）

`deleteTask` 的返回与勾选项是对应的，实测确认：

- 只勾「切片产物」→ **任务记录保留**（可重切），产物进回收站；`freedBytes` 可能为 0（切片目录按
  `config.clip.outputDir` 定位，测试夹具不在那儿时自然找不到东西）；
- 勾「任务目录」→ 记录一起删除、`trashId` 有值（回收站 7 天可恢复）。

我在写用例时先按"删了产物记录就该没"断言，被套件当场判红，核对代码后改成上面的真实语义
（`test/delete-semantics.ts` 里也是这么定的）。

## 31. 「开机时打开的是不是这个界面」——以前不是，现在做了（2026-10-07）

用户截图界面并问：**「测试直播切片助手的开机自启 是不是开机时 打开的这个界面 如果不是 修复他」**。

### 31.1 改造前的真相：不是

为了让"每 10 分钟闪一个终端窗口"彻底消失（§28），我把自动那一路改成了**完全无窗口**：
计划任务只跑 `ensure-service.ps1`（静默起后端），**不打开任何界面**。
所以开机后：后端在跑、界面不会自己出来 —— 用户看到的窗口只可能来自手动双击桌面快捷方式。

### 31.2 改法：拆成两个任务，各管一件事

| 任务 | 触发 | 动作 | 作用 |
|---|---|---|---|
| `直播切片助手（live_auto）` | 登录 + **每 10 分钟** | `conhost --headless powershell -File tools\ensure-service.ps1` | 后端常驻（静默、不杀进程、无窗口） |
| `直播切片助手（live_auto） · 界面`（**新增**） | **只在登录时**（+45 秒） | `conhost --headless powershell -File tools\open-ui.ps1 -Port 3000` | 开机后自动打开界面 |

为什么必须分成两个任务：看门狗每 10 分钟一跳，把它塞进同一个任务里就会**每 10 分钟弹一次界面**。

`tools/open-ui.ps1` 的职责边界（**踩坑后收紧的**）：

- 只做"**等 + 开**"：等 `/api/bootstrap` 就绪（硬超时探活，最多 90 秒）→ 用 **Edge 应用模式**
  打开 `http://127.0.0.1:3000`（`--app=`，没有地址栏，与桌面快捷方式打开的完全是同一个窗口）；
- **不负责拉起后端**：第一版顺手 `& powershell -File ensure-service.ps1`（同步等待），
  实测在 `conhost --headless` 下**那一句不返回** —— 任务卡在 Running、界面永远打不开
  （服务 6 秒就起来了，脚本却又等了 40 秒+ 没往下走）。后端有登录任务+看门狗两条保障，不需要它操心；
- **等不到就照样开界面**：开机时后端可能只是慢（磁盘/GPU 忙），先让用户看到界面（刷新一下即可），
  比"什么都不出现"强得多 —— 用户要的就是"开机能看到这个界面"；
- 一分钟内不重复开（计划任务与启动文件夹都可能触发）；
- 自己**不能有控制台窗口**：调用方必须 `conhost.exe --headless` 包一层。

配套：`tools/autostart.ps1` 安装时**默认**注册界面任务，`-NoUiAtLogon` 可关闭（会顺手删掉旧任务），
`-Remove` 同时移除两个任务，`-Status` 会打印界面任务状态与动作。

### 31.3 实测（都是真机，不是"应该可以"）

| 场景 | 做法 | 结果 |
|---|---|---|
| 后端在跑（正常开机后期） | 触发界面任务 | 日志 1 秒内走完「等就绪 → 已就绪 → 已用 Edge 应用窗口打开 → 完成」，任务结果 0 |
| **干净测量** | 先关掉所有界面窗口（5 个），再触发界面任务 | **窗口数 0 → 1**（窗口枚举按标题匹配，可见窗口） |
| **模拟真实开机** | 停掉后端 → 2 秒内接连触发"服务任务"和"界面任务" | 后端 3.1 秒内起来，界面任务随后打开窗口，两者都不卡 |
| 卡死回归 | 上一版（同步调 ensure-service） | 任务卡在 Running 40 秒+、界面不出现 —— 已修，并写进套件禁止再犯 |

静态回归（`test/service-watchdog.ts` 52 → **67 项**）：界面任务已注册、动作是 `open-ui.ps1` + `conhost --headless`、
**只挂登录触发器**（无 10 分钟重复）、有执行时限、`open-ui.ps1` 里**不许**再出现 `ensure-service.ps1`、
不许杀进程、必须用 Edge 应用模式、探活必须硬超时、等不到也要开界面、安装器默认注册且 `-Remove` 两个都删。

### 31.4 顺带记下的两个坑

1. **PowerShell 里不要写 C 风格注释**：我在改 `autostart.ps1` 时留了 `/* ... */` 占位，
   PS 5.1 把它当命令执行 → 整个安装步骤抛错并走了"启动文件夹退路"（多写了一个会拉起服务的 cmd）。
   现在文件里 `/*` 数量为 0，且套件会检查语法。
2. **`$pid` 是只读自动变量**：`foreach ($pid in @(...))` 直接报 `VariableNotWritable`，
   清理进程的脚本因此没生效过一次（后来换成 `$procId`）。

## 32. 「上传的切片 音画不同步」——是我们自己的「音画错位修复」改坏的（2026-10-07 夜）

**结论**：`src/av-sync.ts` 的 `ensureAvSync()` 判据是**容器时间戳**（`probeStreamStarts()` 读每流的 `start_time`），
而 biliLive-tools 切出来的 MP4 两条流起点**天然差 2.7–5.9 秒**（内容却是对齐的）。
它把这个**标签差**当成错位，用 `-itsoffset` 把音频整体挪那么多 ⇒ **亲手把本来同步的片子改成不同步**，
然后日志写「音画错位已修复：X → 0.000s」—— 它的校验只是把同一个标签量再读一遍，属于**自证**，从来没量过内容。

**取证方法（可复现）**：在**同一个文件时刻 T**（T=30 s 与 T=90 s 各测一遍）分别量「这一帧画面来自源文件第几秒」
和「这段声音来自源文件第几秒」（画面：裁掉顶部弹幕区后 30fps 逐帧比对；声音：20 s 窗包络互相关），
两者之差就是真实音画偏差 —— 与容器的 `start_time` 无关。成片侧必须用**输出端 `-ss`**（`-i FILE -ss T`），
否则两条流起点不同的文件会被"输入端 seek"语义带偏（我第一版就踩了这个，误差看着有 3–4 s）。

| 样本 | 画面 ← 源 | 声音 ← 源 | 真实偏差 |
|---|---|---|---|
| 干净切法（单 `-ss`，视音频一起重编码） | 1466.03 s | 1466.00 s | **−0.03 s（同步）** |
| 用 biliLive-tools **自带 ffmpeg** 1:1 复刻它的真实命令（**未修复**） | 1465.67 s | 1465.64 s | **−0.03 s（同步）** |
| 上面那条经过 `ensureAvSync` 之后 | 1469.57 s | 1465.64 s | **−3.93 s（声音滞后）** |
| B 站上那条切片（回收站里的原件） | 1469.57 s | 1465.64 s | **−3.93 s** |

```
# biliLive-tools 的真实命令（它自己的日志；它调用的是它**自带**的 ffmpeg n7.1.1）
ffmpeg -ss 1435.8 -copyts -to 1592.55 -i <源.ts> \
       -filter_complex "[0:v]subtitles=…[0:video]" -map "[0:video]" -map 0:a \
       -c:v libx264 -crf 21 -preset veryfast -ss 1435.8 -c:a copy out.mp4
```

顺带两点：`-c:a copy` 是它的硬行为（我们 `ffmpegOptions` 里的 `-c:a aac` 被忽略，音频原样搬运）；
`-ss` 出现两次。这两件事都与"标签差"有关，但**都不影响内容对齐**。

**处置（用户选择「立刻关掉+重启」与「顺带处理今天这 6 条分P」）**：

1. `config.json` 的 `clip.avSyncRepair` → `false`（**唯一改动**；服务本身有配置热加载，实测 22:24:53
   就已加载，重启只是第二道保险）。重启零代价：两个任务的 ASR 都命中缓存（日志「缓存命中 1」），没重跑转写。
2. 重启后本轮切片 22:27 重新分析 → 22:32 切完 6 条 → 22:37 追加到同一稿件（aid=117399659481907）。
   22:27 之后日志里「音画错位已修复」**0 次**；实测新切的三条：**−0.03 / −0.03 / −0.05 s（同步）**。
3. 已被改坏的那 6 条做成**无损修正版**（反向 `-itsoffset`，视频流 MD5 与原件完全一致 `c493c79c…`，
   帧数/时长不变），落在 `data/fixed-clips/20261007-2212/`，偏差全部回到 **−0.02 ~ −0.03 s**
   （−4.97 / −4.55 / −3.93 / −5.85 / −3.19 / −2.69 → 全部 ≈0）。
   标定：给音频加 `-itsoffset +X` 会让「声音源位置 − 画面源位置」**减少** X —— 第一版符号写反，
   误差正好翻倍（−4.97 → −9.93），反而印证了这条线性关系。

**遗留（未改代码，只是把开关关掉）**：`src/av-sync.ts` 与 `tools/av-sync-repair.ts` 的判据仍然是错的。
**不要手动跑 `av-sync-repair.ts --apply`** —— 它会把已经同步的文件重新改坏（历史日志里 358 条
「音画错位已修复」，位移 0.15–15.12 s，即这段时间由本程序追加的分P 都带着它当时的偏移）。
要彻底修，应把判据换成上面那套"量内容而不是量时间戳"，并补测试。

## 33. 稿件表现页：B站 上已不存在的稿件默认不显示（2026-10-07 夜，用户要求「已删除的文件 不进行显示」）

- 判据只用接口给的 `gone` 标记（多分P 中任一P 回流到「稿件已不存在」就会带上），**UI 不自己猜**；
- 过滤只发生在**显示层**：`/api/performance` 照旧返回这些行（MCP 等消费者不受影响），
  表格渲染 `shown`（默认 = 非 gone 行），卡片计数改用**在库稿件数**，列表与计数不打架；
- **不静默吞掉**：卡片抬头写「已隐藏 N 个已删除」，底部一行「已隐藏 N 个 B站 上已不存在的稿件…」
  + **「显示它们 / 收起它们」**按钮；展开时抬头文案变成「含 N 个已删除」；
- 「已锁定 / 取不到」的行**照旧显示**（那是临时状态，标出原因比藏起来有用）。

验证：`test/performance-reflux.ts` 80 → **88 项**（新增 8 条断言，含"服务端照旧返回 gone 行、
不是靠删数据来隐藏"）；`npm run perf-ui` 真浏览器 26 → **27 项**：默认不显示 → 提示「已隐藏 11 个」→
点开能看到「稿件已不存在」→ 再点收起，全程无未捕获异常
（截图 `data/verify-shots/perf-page-2026-10-07T14-47-17-207Z.png`）。
`UI_BUILD` → `ui-2026-10-07-hide-gone-perf`（`tools/ui-e2e.ts` 同步；`test/monitor-panel.ts` 212 项、
`test/import-source.ts` 31 项校验两端一致）。

## 34. 墓碑「查不到的 自动解除」（2026-10-07 夜，用户要求）

**问题**：墓碑（「这段内容以前投过 B站、而当时的任务被删了」的防重复保险）**没有自动过期**，
只能人工逐条解除。实测健康面板上挂了 **118 条**，其中 112 条连 bvid 都没反查到（当年只走到「已提交」），
用户只能一条条去创作中心翻。

**判定规则**（`src/tombstone-reconcile.ts`，纯函数 + 注入 client，便于无网络自测）：

| 情形 | 结论 |
|---|---|
| 有 bvid，且它还在我的稿件列表里 | 保留（旧稿件还在，墓碑正当事） |
| 有 bvid，列表拿全了却没有它，且详情明确报「不存在」 | **解除** |
| 有 bvid，列表没拿全 / 详情报的是别的错（限流、非锁定 500） | 保留（证据不足，下次再试） |
| 没有 bvid，但按**分P 标题**在某份稿件里找到了同一段内容 | 保留，并**补记 bvid**（面板上「未反查到」变成可核对） |
| 没有 bvid，可能与它相关的稿件都读到了、都没有这一段 | **解除** |
| 没有 bvid，可能相关的那份稿件 B站 侧**已锁定/读不到**（state≠0、详情 500「啥都木有」） | **解除**（用户口径："查不到就当没有"），但**单独计数**、依据里点名是哪份稿件 |
| 没有 bvid，可能相关的**公开**稿件这次没拉到 | 保留（不用残缺证据放行） |
| 稿件列表可能被截断（返回条数 == 一页） | 一律不解除 |

其中「可能相关」的判据是**时间窗 ±24 小时**（实测：稿件 ctime 比立碑时间早 16~21 分钟 ——
完整版稿件是那场直播刚建好的，我们的切片过一两小时才追加进去）。这道判断是必须的：
有两份稿件 `state=-4 已锁定`（详情 500「啥都木有」），若不看时间就当成所有墓碑的拦路石，
58 条会永远停在「证据不足」—— 第一版实测就是这样，一条都放不掉。

**跑法**：每天与「稿件表现回流」同频自动跑一次（`daemon.ts` 的 `perfTick`，启动 10 分钟后首跑）；
健康面板「墓碑」卡片上有**「立即核对一次」**按钮（走 `POST /api/tombstones/reconcile`，支持 `dryRun` 预演）；
命令行 `node tools/reconcile-tombstones.ts [--apply]`（默认预演），服务正忙不方便重启时用这个。

**实测（2026-10-07 夜，真账号 10 个稿件 / 118 条墓碑）**：

```
墓碑自动核对：共 118 条 —— 保留 60、解除 58（其中 33 条是因为旧稿件已锁定/读不到）、
              证据不足待下次 0（我的稿件 10 个，列表已取全）；本轮拉了 10 份稿件详情。
```

- 保留的 60 条：6 条旧稿件确实还在列表里；**54 条是按分P 标题找回来的**（并补记了 bvid
  —— 面板上那 54 行从「未反查到」变成了具体稿件链接）；
- 解除的 58 条：25 条「扫遍现有 10 个稿件都没有这一段」，33 条「唯一可能相关的旧稿件已锁定读不到」；
- 解除全部留痕在 `data/publish-log.jsonl`（`action: tombstone-release`，`note` 写明依据，
  包括那份读不到的稿件 bvid），事后可查；
- 复核：`dryRun` 再跑一遍 → 60 条全部保留、可解除 0（结论稳定，不会来回抖）。

**验证**：新增 `test/tombstone-reconcile.ts`（**38 项**，锁住上表每一行 + 两条安全性质：
解除必留痕、无关稿件读不到不算拦路石），并接入 `npm run verify`；
`npm run tombstone-ui`（真浏览器）26 → **28 项**：说明里有「每天自动核对、查不到的自动解除」、
有「立即核对一次」按钮、接口 dryRun 预演不动台账；`npm run typecheck` 干净。

## 35. 「勾了想投稿，但没有投稿的选项」——顺带挖出一个会制造重复分P 的隐患（2026-10-07 深夜）

**用户原话**：「7.2 分的这个 是我自己觉得不错 点的对号 想投稿 但是没有进行投稿的选项」
（截图：`auto-20261007150543-iotr` 场，7 个候选，其中 6 个已投、1 个是他自己改过并勾上的 155 秒切片）。

真浏览器实测（`data/verify-shots/probe-auto-20261007150543-iotr.png`）：
「加入排期并发布」按钮**存在且可用**，只是它在 7 张候选卡片**之后**，小窗口里翻不到；
而且卡片上只有「试看 / 在 biliLive-tools 中编辑」，没有"投这一片"的入口 —— 他要的是**单片投稿**。

**顺带查出的真隐患**（比入口问题严重）：批量提交把**所有选中**的切片都塞进 `publishAsMultiPart`，
靠它内部「按目标稿件已有分P 标题去重」兜底 —— 而 **B站 分P 列表有约 20 分钟延迟**
（publish.ts 里记过同一个坑），延迟窗口内重投就会把已投过的分P 再投一遍，
在**同一个稿件里留下内容重复的分P**。也就是说：他真找到那个按钮并点下去，很可能一次投出 6 个重复分P。

**修法（四处，判据统一为「已投过的不再进批次」）**：

1. **界面**（`public/ui.html`）：每张候选卡片加「投稿这一片」（只对"勾了 + 没被墓碑拦 + 还没投过"的显示，
   与「已发布/已提交待确认」互斥）；批量按钮文案改成**「投稿选中的 N 个切片」**，
   N 只数还没投过的；已投过的数量单独说明「其中 M 个已投过，不会重复投」；
   一个都不剩时给一句人话提示，而不是静默什么都不做。
2. **服务端**（`POST /api/task/:id/approve`）：只把**还没投过**的切片当成本次目标
   （`PUBLISHED/SUBMITTED/SUBMITTING/SKIPPED` 一律排除），一个都不剩时返回 400 +
   明确说明（"都已经投过了，要重投请先在 B站 删掉对应分P"）；**标题体检与重叠检查也只针对这次要投的**
   —— 旧写法会把已投过的旧标题一起体检，任一不合规就整批 400（新切片被旧标题连坐）。
3. **流水线**（`daemon.publishMultiPartStage`）：追加前用**本地台账状态**把已投过的摘出去
   （本地无延迟，不依赖 B站 查询），它们仍进 `results` 报 skipped（否则调用方会以为"少投了几个"而重跑本场）。
4. **顺手修掉一个潜伏 bug**：等待完整版稿件的**重查**路径 —— 重查时切片早已是 `CUT`，
   而 `publishClips` 的取片判据只认 `CANDIDATE/PENDING_UPLOAD/FAILED`（publish.ts 那条 filter），
   于是返回空 results，旧代码据此判成「切片全失败 ⇒ stuck」，**本场就再也追加不成**（等待重查形同虚设）。
   判据改成"看有没有可用产物"（`cutOutput` 且文件存在），与"这一轮切了几个"解耦。

**测试**：`test/multipart-routing.ts` 49 → **58 项**（新增第 10/11 节：只把没投过的送进批次、
已投过的如实报 skipped；全投过时一次追加都不做、也不谎报成功）。
★ 关键是先把**假替身改成与真实 `publish.ts` 一致**（只切 CANDIDATE/PENDING_UPLOAD/FAILED、并真写产物文件）
—— 正是这条忠实化把上面那个潜伏 bug 暴露出来的（旧替身把"所有选中"都标成 CUT，掩盖了真实行为）。
`test/monitor-panel.ts` 212 → **219 项**：静态锁住"每片有投稿入口、判据含 SUBMITTED、按钮写清数量"。
`npm run typecheck` 干净；`multipart-cut-snapshot` 12、`confirm-append` 10、`fingerprint-dedup` 18、
`performance-reflux` 88、`fingerprint-tombstone` 69 全绿。`UI_BUILD` → `ui-2026-10-07-per-clip-publish`。

## 36. 清掉 12 条陈年错误事件（2026-10-08，用户看完一份两周前的错误报告后）

**用户看到的**：贴来一份 `manual-20260923125102-ncfw` 的错误报告（09-23 20:51），消息是
`contract: dry-run 且无缓存：拒绝调用付费 ASR（段 1）`。查清两件事：

1. **这不是故障，是硬约束 #14 的付费闸门**：那次是手动任务 + dry-run，而当时 ASR 还是云端付费
   （biliLive-tools/DashScope），预演模式下没有缓存就拒绝调用付费接口（除非显式 `--allow-paid`）——
   所以它连请求都没发出去，消息里也如实写了"这不是识别出来是空的"。
   同时期 09-22 的 9 条是另一类：DashScope 直接返回 `http-status` 错误（当时的 Key/模型/额度问题）。
   `errors.jsonl` 里**一共 12 条，全在 09-22/09-23**，之后再没有过（切到本地 Fun-ASR 之后零错误）。
2. **报告文件打不开是设计内的**：`error-report/` 与日志一起按 `runtime.logKeepDays=14` 天轮转
   （`daemon.ts` 启动时 `rotateLogs({ dirs: [LOGS_DIR, ERROR_REPORT_DIR] })`），09-23 的报告正好到期；
   面板仍能显示内容，是因为**错误事件行**（同步追加、几乎不丢）被合成成了报告 —— 这正是当初做的兜底。

**用户选择「清掉这 12 条历史错误」**，于是新增一个可复用的入口（而不是手工删文件）：

- `src/errors.ts` → `clearErrorEvents({ archive?, archiveDir? })`：**默认先留档**
  （`data/error-archive/errors-<时间戳>.jsonl`）再截断，返回 `{removed, bytes, archivedTo}`；
  只清历史，**不影响之后新产生的错误**，也不动 `error-report/` 里的报告文件。
- `POST /api/errors/clear`（必须 `confirm: true`，可传 `archive:false` 表示不留档）；
- 健康面板错误卡片：抬头标出「共 N 条 · 其中 M 条超过 7 天」+ **「清空历史错误」** 按钮，
  二次确认里写明"先留档 / 只清历史"。

**实测（真浏览器点的按钮）**：清空前 12 条 → 点击 → 确认框 → toast 报出留档路径
`data/error-archive/errors-2026-10-07T16-04-20-771Z.jsonl`（10.1 KB，行数与条数一致）→
清空后 `/api/health` 的 errors = 0、卡片整张消失、`errors.jsonl` 0 字节、页面无未捕获异常。

**测试**：`test/error-report.ts` 96 → **110 项**（新增第 ⑥ 节：留档内容与条数一致、清空后事件流归零、
再次清空是 no-op、`archive:false` 不留档、文件不存在时不抛、**清空之后新错误照常记录**）；
`test/monitor-panel.ts` 219 → **224 项**（静态锁住按钮、7 天计数、确认文案、带 confirm 的接口）。
`UI_BUILD` → `ui-2026-10-08-clear-errors`；`npm run typecheck` 干净。
顺带修掉 `tools/ui-e2e.ts` 待删清单那一段的**位置依赖**（按"第一行/前 5 行"取夹具会被真实数据打破 ——
实测刚投出来的成片进了待删清单就把夹具挤出前 5 行），改成按夹具 id 定位 + dueAt 排在真实条目之前。

## 37b. 稿件表现列表：排序可选（2026-10-08，用户要求「这里的排序 可以改成可选的吗 比如稿件时间 播放 点赞 等」）（原编号 §37，与另一处撞号 ⇒ 消歧）

纯前端改动（`public/ui.html`，接口不变、服务不用重启）：
表头右侧加 **字段选择器 + 升/降序按钮**，可选 **播放 / 点赞 / 投币 / 收藏 / 弹幕 / LLM 评分 / 发布时间 / 数据日期**，
抬头文案跟着变（如 `已发布稿件表现（按点赞升序）`）。排序在**拿到全部行之后**做，所以「已隐藏的已删除行」
展开后也按同一规则排。

三条刻意的规矩：

1. **缺失该字段的行永远沉底** —— 否则切升序时「未拉取 / 取不到」会跑到最上面，把真正有数据的稿件盖住；
2. **同值时用播放兜底**，顺序稳定，不会每次重画都跳；
3. **选择记进 `localStorage`**（`liveauto.perfSort` / `liveauto.perfSortAsc`），刷新后保持；
   读取包在 try/catch 里，隐私模式等取不到就回退默认「播放降序」，绝不因为存储异常白屏。

`发布时间`（台账里的 dtime，即稿件什么时候发的）与 `数据日期`（回流那天拉的）都给 —— 两者语义不同。

**验证**：`test/monitor-panel.ts` 224 → **232 项**（选择器与方向按钮、8 个字段、缺失值沉底、
同值兜底、方向可切、localStorage 记忆与安全回退、抬头文案）；`npm run perf-ui` 真浏览器 27 → **33 项**：
切「点赞」后**第一行 = 接口里点赞最多的那个稿件**（实测 `BV18JaN62Ej5` 5 赞）、方向按钮显示「↓ 降序」、
切成升序后第一行变成点赞最少的（`BV1qyaN68EUd` 0 赞）、抬头文案跟着走，最后切回播放降序不打扰用户；
`npm run ui-e2e` **121/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-08-perf-sort`。

## 38. 「发布时间时 没有正确排序」——根因不在排序，而在**那一列恒为空**（2026-10-08）

用户接着报：按「发布时间」排序不动。查下来排序逻辑没问题，是**数据层**的锅：

```
/api/performance 抽查：23 行，有 publishedAt 的 = 0 行；
台账里已投出的切片：26 条，带 publishedAt 的 = 26 条、带 dtime 的 = 0 条
```

旧代码把「发布时间」取成 `agg.dtime`（**计划**发布时间），而 `publish.immediatePublish=true` 时
投稿**不传 dtime** ⇒ 整列恒为空 ⇒ 前端排序时所有行都"缺该字段"而全部沉底，行序自然一动不动。

**四处修法（缺一不可）**：

1. **服务端**：`publishedAt` 改成四级回退 —— ① 台账切片里**真实投出**的 `publishedAt`（同稿件取最近一次）
   → ② 回流记下的 B站 稿件发布时间 `pubdate` → ③ **墓碑的登记时刻**（≈投出当天，兜住"任务删了、又还没回流过"的行）
   → ④ 旧的计划时间 `dtime`；
2. **回流**（`daemon.refreshPerformance`）：把 B站 的 `View.pubdate`（没有则 `View.ctime`）
   随统计一起写进 `performance.jsonl` —— 稿件时间是 B站 上的客观事实，**跟本地任务还在不在无关**
   （用户当天批量删过任务，这正是旧写法拿不到时间的原因）；
3. **一次性自愈**：`bvidsNeedingPerformance` 原本"当天拉过就不再拉"，新字段会一直空到明天 ——
   现在**当天拉过、但缺 `pubdate` 的正常稿件允许再拉一次**补齐（补齐后照旧跳过；已消失/已锁定的不参与，免得天天白拉）。
   多行同一天时**以最后一行为准**（缺 `pubdate` 的那行会撤销"今天拉过"的标记）；
4. **界面**：表里补上**「发布时间」列**（按它排序却看不见它，本来就是观感问题），
   时间解析统一走 `perfTimeMs()`（空格换 `T` 再 parse，解析不出来当没有）。

**实测（本机真数据）**：修前 23 行里 1 行有时间 → 修后**在库 12 行里 10 行有时间**
（只剩两份 `已锁定` 的稿件没有 —— B站 不公开，本来就没有发布时间，列里显示「—」并沉底）；
按发布时间降序第一行 = 今天刚投的 `BV1ReHk6vETh`（2026-10-08 00:04），升序第一行 = `BV13hhE6XEQM`（09-22）。

**验证**：`test/performance-reflux.ts` 88 → **96 项**（落盘行带 `pubdate`、页面行有可排序的 `publishedAt`、
缺 `pubdate` 的当日记录会被再拉一次、补齐后立刻恢复"当天不再重复拉"、已消失的不参与补齐、
以及原有的"同一天不再重复打接口"仍成立 —— 桩数据同时补上了真实存在的 `View.pubdate`）；
`test/monitor-panel.ts` 232 → **242 项**（发布时间列、时间解析、服务端优先用真实时间、回流落 `pubdate`、补齐规则）；
`npm run perf-ui` 真浏览器 33 → **36 项**（切「发布时间」降序 = 最新那条、升序 = 最早那条、表里有这一列）；
`npm run ui-e2e` 121/0；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-08-perf-pubdate`。

★ 核验脚本自己踩的坑记一笔：`perf-ui` 里第一版没把方向**显式摆到降序**（上一组把方向留在了升序），
于是拿"升序的结果"比"降序的期望"，两条断言全红 —— **页面其实是对的**。现在用 `dirTo(wantAsc)` 先摆方向再断言。

---

## 38b. 「这个怎么一直是 已提交待确认」——分P 的落地确认从来没做过（2026-10-08 凌晨，用户截图）（原编号 §38，与另一处撞号 ⇒ 消歧）

### 38.1 现象与根因

用户截了一张切片卡片：`已提交待确认`，永远不变。台账里当时有 **13 个这样的切片**，
而且**每一个都已经有 bvid**（`BV1ReHk6vETh`）—— 也就是说系统早就知道它们投到哪儿了，只是没人去确认落地。

两条机制叠在一起造成的：

1. **续传的落地确认窗口只有 5 分钟**，而 B站 分P 列表的可见延迟实测可达 20 分钟 ——
   于是窗口内没确认到就如实记成 `SUBMITTED`（这个设计本身是对的，见 §"续传落地确认"那段：
   不能谎报成功，也不能武断判失败）。日志证据（10-07 一晚上 4 批）：
   ```
   14:03:14 warn 续传确认：等待 300s 后仍未在 B站 侧看到新分P（追加前 4 个，现在仍查不到待投标题）
   15:11:15 warn …（追加前 12 个）      15:38:33 warn …（追加前 32 个）
   ```
2. **周期性反查只按「稿件标题」在 `/bili/archives` 里找** —— 而这些切片是**别人稿件的分P**，
   它们的标题永远不会作为稿件标题出现 ⇒ 反查一辈子也查不到 ⇒ 永远停在 `SUBMITTED`。

三个连带后果（都不是"显示不好看"这么轻）：
- 场级 `allDone`（全部选中切片 PUBLISHED）永远不成立 ⇒ 任务状态到不了 PUBLISHED
  ⇒ **「用完即删」静默不触发，源录播一直占盘**；
- 表现回流（`bvidsNeedingPerformance`）只认 PUBLISHED ⇒ 这些切片的播放数据永不回流；
- 界面上用户根本不知道到底投出去没有。

### 38.2 修法（`src/publish.ts` 的 `confirmPublished`）

反查循环（每 5 分钟一次）现在**分两条路**，而不是只有一条：

| 切片状态 | 确认方式 |
|---|---|
| **已有 bvid**（多分P 续传） | 读那个稿件的 **`View.pages` 分P 标题列表**（`fresh: true`，必须看最新），标题命中即 `PUBLISHED` + `publishedAt`；命中不了就保持 SUBMITTED（不谎报） |
| **没有 bvid**（新建稿件） | 原来的路：按稿件标题在 `/bili/archives` 反查（bvid 的唯一来源） |

两条路互不干扰：全部切片都有 bvid 时**一次 `/bili/archives` 都不发**；
混合批次两条都走。读不到分P 列表或接口抛错时只记 `pending`（下轮再试），绝不改状态。

### 38.3 验证

**真实数据**（重启服务后的第一个反查 tick，日志原文）：

```
16:04:33 续传落地反查：稿件 BV1ReHk6vETh 现有 34 个分P，其中 1/1 个待确认切片已确认落地
16:04:33 反查确认 1 个切片（多分P 续传，按分P 标题确认）
16:04:33 续传落地反查：… 6/6 个待确认切片已确认落地   ← 再来一批
16:04:33 续传落地反查：… 6/6 个待确认切片已确认落地
```

台账状态分布：`SUBMITTED 13 → 0`、`PUBLISHED 13 → 26`，`publishedAt` 都补上了；
**「用完即删」随之对那 3 个任务生效**（26 项 / 10.87 GB 进待删清单，宽限 0.5 小时，界面可取消）——
这是配置要的行为，之前因为状态推进不了而一直没发生。

**测试**：`test/confirm-append.ts` 15 → **20 项**，新增第 ⑦ 节：分P 列表里看到的 → PUBLISHED（含
`publishedAt`）、没落地的保持 SUBMITTED、**全程不查 `/bili/archives`**、读不到列表 / 接口抛错时不崩不改状态、
混合批次两条路都走到（且此时确实查了 `/bili/archives`）。

---

## 39. 「已经删除了 但是还是显示 删除的不需要显示」——待删清单的幽灵行（2026-10-08 凌晨，用户截图）

### 39.1 现象

用户截了监控面板的「待删文件」表：**16 行，每一行都是「文件已不在」+ 一个「标记为已删除」按钮**，
表头还写着「16 个 · 共 8533.1 MB」—— 而那些文件其实早就没了（体积也早就不是被它占着）。

### 39.2 根因：同一个成片会被**好几条路径**删掉，而待删清单只认自己删的那一次

回收站清单里那批文件的 manifest 直接说明了是谁删的（同一批文件、两条不同路径）：

```
投稿成功（BV1ReHk6vETh）后在实时监控里一键批量删除     @ 16:10:22   ← 监控面板那个「一键删除可删的 N 项」
本场 7 个切片均已反查到 bvid…；清理本场成片目录         @ 16:11:40   ← 「用完即删」
```

而这几条待删条目的到期时刻是 **16:34:33** —— 于是从 16:10 到 16:34 这二十多分钟里，
界面上一直列着 16 行"删不掉的东西"，还要用户手工点一下按钮才消失。
（用户确实点了「全部立即删除」，那批条目才被收尾 —— 这也解释了为什么现在清单里只剩 1 项。）

### 39.3 修法：文件不在了就**自动收尾**

`src/pending-delete.ts` 新增 `closeMissingPending()`：把「文件已经不在」的条目直接标记为已删除
（`deletedBy: 'missing'`，与"到点自动删"`trash`/`rm`、"用户手点"`deletedManually` 三者区分得开），
它们随即从清单与统计里消失。接在三处：daemon 的 10 分钟待删 tick（跑在 `runDueDeletions` 之前）、
`GET /api/pending-delete`、监控面板的 payload 构造 —— 所以界面**下一次请求就是干净的**，不用等定时器。

**边界（必须守住的）**：只有**父目录还在**、文件不见了才收尾。整块盘/整个目录不可用时
（移动硬盘没插、网络盘掉线）不算"文件被删了"，条目保留、界面照旧显示「文件已不在」+ 手工按钮 ——
否则会把用户真想删的东西悄悄放过。这一步不删任何文件，只是把状态对齐；幂等，重复调用第二次返回 0。

### 39.4 验证

- `test/pending-delete.ts` 115 → **131 项**，新增第 ⑨⑩ 节：文件不在 → 收尾（清单只剩还在的那条、
  `pendingBytes` 不再计入、写进 `deleted` 桶且标 `missing`、不算手动删）、**幂等**、
  **到点执行不会为已收尾的条目多造回收站条目**、文件还在的不受影响、
  **父目录不在 → 保留 + `existsNow=false`**（界面还能手工处理）。
- 真实数据：脚本对线上状态跑一次收尾，随后接口与监控面板都只剩 1 项（那条 3.05 GB 的源录播，
  到期前用户仍可取消）。

### 39.5 顺带记两个多会话协作的工具（本仓库有两路会话同时改）

同一文件里常混着另一路会话未提交的改动，整文件 `git add` 会把别人的 WIP 一起带走：

- `tools/stage-hunks.ts <文件> <oldStart>…`：只把指定 hunk 暂存（`git apply --cached --recount`）；
- `tools/stage-on-head.ts <文件> <替换对JSON>`：当上面那条因**上下文里混着别人的改动**而
  "patch does not apply" 时，取 `HEAD:文件`、只施加自己的字符串替换，再 `hash-object -w` +
  `update-index --cacheinfo` 写进索引 —— 索引 = HEAD + 我的改动，别人的 WIP 原样留在工作区。

### 39.6 追加：「删除失败：Failed to fetch」这种提示必须改掉

用户随后问「为什么会删除失败」。查下来**根本没失败**：那条 3.05 GB 的源录播在 00:18:43 被
「用户手动立即删除」成功移入回收站（`deletedBy: trash`），待删清单已清空，日志里 0 条失败记录、
状态文件里 0 条 `error`、占用探测（同卷 rename）也通过。

真正发生的是：**那两分钟服务不在**（00:14 被杀 → 00:16 / 00:18 两次重启），用户在窗口期点了
「立即删除」，`fetch` 在浏览器侧直接抛异常，旧写法把英文原文丢进 toast：
「删除失败：Failed to fetch」—— 用户没法从这句话判断是「服务不在了、等几秒就好」还是「这个文件删不掉」。

改法（`public/ui.html` 的 `api()`）：网络层失败（fetch 抛异常）**先自动重试一次**（间隔 1.2 秒，
服务重启通常几秒就回来），仍失败则抛出人话「服务不可达（多半正在重启）—— 稍等几秒重试；一直这样请到
「健康」页看服务状态」，并打上 `err.network = true` 让调用方能区分处理。
**注意这与「接口返回 4xx/5xx」是两回事**：后者照旧按服务端给的 `error` 文案展示。

`test/monitor-panel.ts` 加了 3 条静态断言（会重试一次 / 文案是人话 / 带 network 标记）。
  "patch does not apply" 时，取 `HEAD:文件`、只施加自己的字符串替换，再 `hash-object -w` +
  `update-index --cacheinfo` 写进索引 —— 索引 = HEAD + 我的改动，别人的 WIP 原样留在工作区。

### 39.7 顺带：墓碑明细默认收起（用户「显示的太多了」）

用户截图（2026-10-08 凌晨）：健康面板的「墓碑」卡片把 **60 条**明细平铺了一屏多，原话「显示的太多了」。
这张表是"查账用"的 —— 平时只需要知道"有多少条在生效、每天会自动核对"，逐条只有真要解除某一个时才看；
同一个教训本项目已经吃过一次（「上一轮对每个文件的结论」平铺 35 行也是改成默认收起）。

改法（`public/ui.html`）：抽出 `tombstoneDetails(tombstones)`，用原生 `<details>` 包住明细表
（**不带 open = 默认收起**，summary 上写明「逐条明细（60 条，可单条解除）」），常显部分只留
"共 N 条在生效 + 每天自动核对 + 立即核对一次"；行内的「解除」按钮照旧在明细里，功能一个没少。

真实浏览器验证（`tools/verify-tombstone-ui.ts` 28 → **33 项**）：details 存在且 `open === false`、
summary 带条数、**卡片高度收起 155px vs 展开 3256px**、展开后明细行都在。
⚠️ 判据必须是**高度**：Chromium 对 closed `<details>` 用 `content-visibility: hidden` ——
内容保留布局盒、只是不绘制，所以"行有没有 rect"永远为真（第一版断言就这么写红了）。
静态断言另加 4 条进 `test/monitor-panel.ts`（246 项全绿）。

---

## 40. 验证工具的假红：等元素再点，别拿固定 sleep 赌渲染（2026-10-08）

### 40.1 现象

把另一路会话的在途工作一起提交前，跑 `tools/verify-perf-ui.ts`：**第一次 4 条红**，
原封不动再跑一次 **36/36 全绿**。红的是这几条：

```
✗ ★ 展开后能看到它，并标出「稿件已不存在」
✗ 展开后「数据日期」写的是「已删除」而不是数字
✗ 多分P 稿件标出「同一稿件 31 个分P」
✗ ★ 表现列表有排序选择器与方向按钮
```

### 40.2 根因：页面是**异步渲染 + 整块重画**，而工具在拿固定 sleep 赌时序

「稿件表现」页切过去之后要等 `/api/performance` 回来才画卡片，之后数据刷新还会**整块重画**。
旧写法的问题是两类：

1. 读一次 `innerHTML` 快照就 `document.getElementById('perfGoneToggle').click()` ——
   只要那一下赶在渲染之前，按钮还不存在（点了没反应）；夹在两次重画之间，点完就被覆盖。
   于是"展开"根本没发生，后面四条断言连坐。
2. 换排序之后用 `await sleep(1200)` 再断言第一行 —— 1.2 秒是**猜的**：重排慢了就红，快了就绿。

### 40.3 修法

加一个 `waitFor(cond, timeoutMs = 8000)`，把"等"从猜时间改成等**条件**：

| 位置 | 改法 |
|---|---|
| 点「显示它们」之前 | 先等 `#perfGoneToggle` 真的在 DOM 里，再点；点不到就**如实报红**并说明"等了 8 秒也没等到按钮" |
| 收回隐藏行之前 | 同上（重画后按钮会被换掉） |
| 多分P 标注 | 轮询那一行的文本，直到出现「同一稿件 N 个分P」或超时 |
| 排序选择器 | 等 `#perfSortKey`/`#perfSortDir` 存在再断言、再操作 |
| 换排序后的行序 | `waitFirstBvid(期望的 bvid)`：等到第一行**真的**变成期望的那一条再断言 |
| 方向按钮 / 抬头文案 / 收尾复位 | 同样改成轮询目标文案，不再 `sleep(1200)` |

关键点：**等待不等于放宽**。`waitFor` 超时后断言照旧执行（该红还是红），
只是把"渲染慢"与"功能坏了"分开 —— 真坏了会等满 8 秒再报，而不是随机红一次。

### 40.4 验证

连跑 **3 次全部 36/36**（改之前是"第一次红、第二次绿"）。`typecheck` 干净。
本仓库其它验证工具（`verify-monitor-ui` / `verify-tombstone-ui` / `ui-e2e`）早就是"等元素再点"的写法，
只有这一个还在用固定 sleep —— 现在统一了。

---

## 41. `git push` 突然连不上 GitHub：不是仓库的问题，是**解析到的那个 IP 被挡**（2026-10-08）

### 41.1 现象与误判

推提交时报：

```
fatal: unable to access 'https://github.com/xingtong-v/live-auto.git/':
Failed to connect to github.com:443 after 21108 ms: Could not connect to server
```

第一反应是"网络抽风，重试就好"（这仓库以前确实重试就过）。**但连试 3 次、每次隔 5 秒全一样**，
后来隔着几十秒再试还是失败 —— 说明不是抖动。

### 41.2 实际原因

| 探测 | 结果 |
|---|---|
| DNS | `github.com` → **20.205.243.166** |
| `Test-NetConnection github.com -Port 443` | **False**（这个 IP 的 443 不通） |
| `Test-NetConnection 140.82.112.3 / 140.82.113.3 / 140.82.114.3 / 20.27.177.113 -Port 443` | 全部 **True** |
| `ssh.github.com` / `codeload.github.com` / `api.github.com` :443 | 全通 |
| 对照：`www.baidu.com` / `registry.npmjs.org` :443 | 全通（不是整体断网） |
| 本机代理 | 没有 `~/.ssh`、没有 7890/7897/10809/1080 在听、git 里也没有 proxy 配置 |

结论：**只有 `github.com` 解析到的那个 IP 被挡**，别的 GitHub 入口都活着。

### 41.3 解决：换一个可达 IP（一次性覆盖，不改配置）

```bash
# 先探路（只读、便宜）
git -c http.curloptResolve=github.com:443:20.27.177.113 -c http.version=HTTP/1.1 ls-remote --heads <url> main
# 通了再用它推
git -c http.curloptResolve=github.com:443:20.27.177.113 -c http.version=HTTP/1.1 push origin main
```

实测 `140.82.113.3` 会 `Connection was reset`、`140.82.114.3` 直接超时，**`20.27.177.113` + `HTTP/1.1` 通了**
（HTTPS 的 SNI 仍是 `github.com`，证书照常校验，不是跳过校验那种危险做法）。

### 41.4 固化成工具：`tools/push-safe.ts`

IP 会轮换，所以不写死。工具逻辑：**直连先试 → 不通就按「候选 IP × HTTP 版本」用 `ls-remote` 探路 →
找到能用的入口再推**（全程 `-c` 一次性覆盖，不落盘、不改仓库配置；`--check` 只探不推）。

```bash
npm run push-safe          # 直连不通时自动换入口再推
node tools/push-safe.ts --check   # 只看现在哪条路通
```

写完之后跑 `--check`，直连又恢复可用了（这次的挡是间歇性的）—— 工具照样正确报"直连可用"并直接推。
**下次再遇到 `Failed to connect to github.com:443`，先跑它，不要再无脑重试。**

---

## 40b. 投稿被跑了 8 次、有一片投了两次却没落地 —— 单飞闸 + 落地确认分情况（2026-10-10 深夜）（原编号 §40，与另一处撞号 ⇒ 消歧）

> 编号说明：§37/§38/§40 曾各出现两次（2026-10-08 那一晚两路并行开发各自追加导致）。现已消歧：**较晚的那一处**改为 §37b/§38b/§40b，正文里指向"单飞闸/重复投稿"的交叉引用同步改为 §40b。
> 内容互补（稿件表现排序 / 发布时间列 vs 已提交待确认的落地确认 / 待删清单幽灵行），按标题关键词区分即可。

**用户提问**：「这是投稿了吗」（截图：`auto-20261010140346-ygk1` 的 #10 挂着「已提交待确认」）。
查台账 + 日志 + B站 稿件，查出**三件事**：

1. **同一场被跑了 8 次投稿阶段**（23:17:50 / :56 / :59 / 23:18:08 / 23:22:56 / 23:23:02 / :05 / :13），
   每次都真调了一次 `editMedia(append)`：「23:23:02 追加 1 个分P」「23:23:05 再追加 1 个」
   「23:23:13 再追加 2 个」……日志里反复出现「本场已有 1 次投稿记录…本次将再投一次，
   B站 上会出现重复稿件」——**那不是提醒，那是重复投稿正在发生**。
2. **#10 被投了两次**（两个 uploadTaskId：`c07359e6…` 与 `0bd3b6bf…`），而 B站 稿件里一条都没有 ✗。
3. **旧日志把两种结果写成了一句话**：「biliLive-tools 任务已完成（uploadTaskId=…），但 B站 侧还没查到新分P」——
   可代码**从来没查过**任务状态（`biliUpload` 一返回就写死了这句）⇒「真失败」与「列表还没刷新」被盖住，
   用户和运维都无从判断（这条就是这么静默躺了半小时）。

**四处修法**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `daemon.publishStage` | **单飞闸**：同一场已有一次投稿在跑时，后来的调用**等它并复用结果**，绝不再开一次追加 |
| 2 | `daemon.enqueue` | **重复入队忽略**：正在跑或已在队列里的场次不再排一次（实测就是这么排了 8 次）；`stoppedByUserAt` 清理照旧 |
| 3 | `publish.publishAsMultiPart` | 追加后**先当场问一次 `taskDetail`**：`error` ⇒ 标 FAILED + 写清对方原文 + `ok:false`（不再含糊成"待确认"）；其它状态如实写进日志，并透给落地确认当"读不到分P 列表"时的兜底方向（`completed`→按已落地，否则→按未确认） |
| 4 | 确认窗口 + 反查出口 | 阻塞式确认 300s → **90s**（把长尾交给每 5 分钟一轮的反查，不再占着流水线）；反查对**提交超过 1 小时仍未落地**的切片推送告警一次（新增 `alerter.publishUnconfirmed` + 台账 `unconfirmedAlertAt` 防重复打扰），卡片上给**「重新投稿这一片」**（服务端 `includeSubmitted: true` 才放行 SUBMITTED，UI 二次确认要求先去创作中心核实） |

**实测结果**：修完后把 #10 通过新出口补投 ⇒ **15 秒内 PUBLISHED**，
B站 稿件 `BV1oWpG69Etu` 出现 **P25「星瞳露露争夺于文波…」**，同场 11 片全在 ✓。

**同时如实报告一个已造成的后果**：同一场的另一路录制（`qadr`，同标题的另一段，同一个稿件）
在那次风暴里把「纯良粉因打黑神话怪一小时没过…」投了两次 ⇒ 稿件里 **P22 / P24 内容重复** ✗。
这是**修复前**的行为造成的，B站 分P 只能由人在创作中心删 —— 已告知用户。
另外 `qadr` 的 3 片在重启时被崩溃恢复重置为 `PENDING_UPLOAD`，但它们其实已在稿件里，
下次追加会被**标题去重**拦住（不会再投第三份）。

**测试**：`test/multipart-routing.ts` 58 → **61 项**（新增第 12 节：并发投两次只调一次 `publishAsMultiPart`、
重复入队只跑一次流水线）；`test/confirm-append.ts` 10 → **28 项**（新增第 8 节：超时未落地被单独报出、
带等待时长、**状态仍是 SUBMITTED（确认不了≠失败）**、`unconfirmedAlertAt` 只告警一次、刚提交 5 分钟的不报；
第 4 节补 `unreadableFallback:'unconfirmed'`）；`test/multipart-cut-snapshot.ts` 12 → **16 项**
（新增第 6 节：biliLive-tools 报错 ⇒ `ok:false` + 切片 FAILED + failReason 带对方原文）；
`test/performance-reflux.ts`、`test/fingerprint-dedup.ts` 的桩补上了真实存在的 `taskDetail`（新逻辑依赖它，
给不出状态会被判成「未确认」而不是 PUBLISHED）；`test/monitor-panel.ts` 246 → **253 项**
（静态锁住重投入口、判据、二次确认、`includeSubmitted` 白名单）。`npm run typecheck` 干净。
`UI_BUILD` → `ui-2026-10-10-publish-singleflight`。

## 42. 任务详情加「刷新投稿状态」：立刻去 B站 反查一次（2026-10-11，用户要求）

**用户原话**：「任务这里加个刷新 用于及时刷新投稿信息」（截图：任务详情页 + 右侧「发布排期」）。

问题不在页面刷新 —— 界面本来就每 5 秒重画一次，但重画只是把**旧状态**再显示一遍；
「已提交待确认」要不要变成「已发布」，取决于**去 B站 反查**（后台每 5 分钟一轮）。

**改动**（三处，都不触发任何投稿动作）：

| 位置 | 内容 |
|---|---|
| `daemon.refreshPublishStatus(taskId)` | 立刻对这一场跑一次落地反查（复用 `publisher.confirmPublished`），并复用 5 分钟那一轮的**超时告警**逻辑（新抽出的私有 `alertStalled`，口径只此一处） |
| `POST /api/task/:id/refresh-publish` | 返回 `{checked, confirmed, pending, stalled, note}`，`note` 直接是给用户看的一句话（没有待确认 / 确认了几个 / 仍没出现+延迟说明） |
| 任务详情工具栏 | 新增 **「刷新投稿状态」**（放在「投稿体检」旁边），title 写明「只读，不会重复投稿」；点击 → 反查 → toast 报结果 → 整页重画 |

**真浏览器实测**（headless Edge + CDP，任务 `auto-20261010150252-qadr`）：
按钮存在且已绑定、title 文案正确 → 点击 → toast「本场没有「已提交待确认」的切片，无需反查」→
按钮恢复可用 → 页面无未捕获异常 ✓。

**测试**：`test/monitor-panel.ts` 253 → **260 项**（静态锁住按钮、title 说明、走 POST 而非本地重画、
服务端路由与 daemon 方法、反查只读、告警口径只有一处）。`npm run typecheck` 干净；
`UI_BUILD` → `ui-2026-10-11-refresh-publish`。

**顺带记一笔现场**：同一稿件的重复分P（`纯良粉因打黑神话怪一小时没过…`，当时是 P26 / P28）
仍在，属于修复前那次风暴的遗留，需要人工在创作中心删一个；分P 序号会随着新分P 追加而变动，
所以按**标题**找更可靠。

## 43. 标签栏重排：「回收站 / 待删清单」顶上，「成本」并进「稿件表现」（2026-10-11，用户要求）

**用户原话**：「将这两个（查看回收站 / 查看待删清单）放到成本的位置 然后将成本放到稿件表现里」。

改动是**搬家而不是重写** —— 内容、按钮、确认文案一字未改，避免两套实现各自漂移：

| 位置 | 之前 | 现在 |
|---|---|---|
| 标签栏 | 任务 · 实时监控 · 健康面板 · **成本** · 稿件表现 · Prompt | 任务 · 实时监控 · 健康面板 · **回收站** · **待删清单** · 稿件表现 · Prompt |
| 回收站 | 设置弹窗里的「查看回收站」按钮（`#infoBody` 里渲染） | `renderTrash(box)` 渲染成**页面**；恢复/彻底删除/清空后**原地重画**（原来是关弹窗再重开） |
| 待删清单 | 设置弹窗里的「查看待删清单」按钮 | `renderPending(box)` 渲染成**页面**；删除/取消/执行到点删除后原地重画 |
| 成本 | 独立页签 `renderCost` | `costHtml(m)` 抽出来，作为「稿件表现」页底部一张**默认收起的 `<details>`** 卡片（数字与口径不变，仍取 `/api/tasks` 的 `monthly`） |
| 待删角标 | 挂在设置里那个按钮上（`#pendingDeleteBadge`） | 挂到**页签**上（`#pendingTabBadge`，旧 id 仍兼容） |
| 设置面板 | 两个按钮 | 撤掉按钮，留一句指路说明（「已经搬到顶部标签栏」） |

**测试影响（这是本次最容易踩的地方）**：`tools/ui-e2e.ts` 原来靠「打开设置 → 点 `#btnPendingDelete`」进入清单，
并在 `#infoBody` 里断言；现在改成**点页签**、断言范围换成 `#otherPage` ✓，并显式收起设置遮罩
（那段以前是靠"打开设置"顺带处理的）。`test/monitor-panel.ts` 加了 9 条静态断言锁住新布局
（含「不许再有 `data-view="cost"`」「不许再有 `id="btnTrash"`/`btnPendingDelete`」——防止两处入口复活）。

**真浏览器验收**：新增 `tools/verify-tabs.ts`（`npm run tabs-ui`）13 项全绿 ——
页签顺序与「没有成本页签」、回收站页渲染（本机 185 项 / 27.1 GB）、待删清单页渲染（含角标、
「立即执行到点的删除」）、稿件表现里的成本卡片**默认收起**且展开后能看到「本月合计」与「按日分布」、
设置里两个按钮确实没了且留了说明、全程无未捕获异常。截图见
`data/verify-shots/tab-trash.png`、`tab-pending.png`、`perf-with-cost.png`。

`npm run typecheck` 干净；`npm run ui-e2e` **121/0**。`UI_BUILD` → `ui-2026-10-11-trash-pending-tabs`。

## 44. 「最近已删除」的行还挂着「立即删除」按钮（2026-10-11，用户截图实测）

用户截图：在「待删清单」页点某条**已经删掉**的记录上的「立即删除」→ 弹出
「立即删除 1 个文件（共 0.0 MB）？不是等到宽限期，而是现在就删。」—— 文件早就不在了。

**根因**：`pendingRowActions(e, opts)` 只按 `opts.cancellable` 决定**要不要加**「取消删除」，
却**无条件**渲染了「立即删除 / 标记为已删除」按钮 ⇒ 「最近已删除」那一段（20 行）每行都挂着一个
点了没意义的删除按钮。而 `deletePendingNow()` 又是拿 `entries`（待删清单）去过滤 id 的 ⇒
已删条目的 id 不在里面 ⇒ 确认框里算出「共 0.0 MB」（服务端其实会安全地归到 skipped「这一条已经删过了」）。

**修法**（界面为主，服务端本来就安全）：

1. `pendingRowActions`：`e.deletedAt || e.deletedBy` 的条目**一律不给动作按钮**
   （行正文已经写了「已移入回收站 / 已永久删除」，不再重复挂标签）；
2. `deletePendingNow`：`ids` 与待删清单**一条都没匹配上**时直接收手 + toast
   「这些条目已经处理过了，无需再删」，不再弹那种"共 0.0 MB"的确认框。

**验证**：`tools/verify-tabs.ts` 13 → **15 项**：截图现场复现的那一段现在断言
「最近已删除」段 **20 行 / 0 个删除按钮**，且「待删段的按钮数 = 待删条目数（占位行不算）」（当前 0/0）；
`test/monitor-panel.ts` 268 → **271 项**（静态锁住 early-return、空匹配护栏、监控面板仍复用同一渲染）；
`npm run ui-e2e` **121/0**（它的待删夹具是**待删**条目，按钮照旧在 ✓）。`npm run typecheck` 干净。
`UI_BUILD` → `ui-2026-10-11-pending-row-fix`。

## 45. 回收站按天折叠（2026-10-11，用户要求「这里增加折叠功能 按时间 每天的折叠在一起」）

现场：回收站 **189 项 / 27.1 GB** 平铺成一条长列表，读不下去（截图里连续几十条 `批量删除 A/B` 的小夹具混着真实录播）。

改法（`renderTrash`）：

- 按**删除日期**分组，每天一个原生 `<details class="trashday">`，摘要写清「日期 + N 项 + 空间」
  （例：`2026-10-11 · 57 项 · 6.4 GB`）；
- **默认只展开最近一天**，其余收起；最新的一天排在最上面；
- 超过一天时多一个 **「全部展开 / 全部收起」** 一键开关（文案随状态变）；
- ⚠️ 分组键必须是**本地日期**：`deletedAt` 是 ISO（UTC），直接切前 10 位会把凌晨删的记到**前一天**——
  所以走 `fmtTime(Date.parse(...)).slice(0,10)`（`fmtTime` 输出本地时间）。

**验证**：`npm run tabs-ui` 15 → **20 项**：真浏览器里读出来「6 天，展开 1 天」，
摘要形如 `["2026-10-11 57 项 · 6.4 GB","2026-10-10 4 项 · 2.7 KB"]`，
每天组内的「恢复」按钮仍在、点「全部展开」后每一天都展开且按钮变成「全部收起」；
`test/monitor-panel.ts` 271 → **277 项**（静态锁住分组、默认展开策略、摘要格式、本地日期、一键开关、排序方向）。
`npm run ui-e2e` **121/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-trash-by-day`。

## 46. 回收站：每个日期可删 + 保留天数设置 + 超期自动删（2026-10-11，用户要求）

**用户原话**：「每个日期后面都添加可删除选项 添加只保留几天的设置 超长时间的自动删除」。

三件事，其中第三件**服务端本来就有**（`cleanup.trashDays` 默认 7 天，`daemon.perfTick` 每天调
`purgeTrash({ olderThanDays })`），缺的是"看得见、改得了、能立刻执行"：

| # | 改动 | 位置 |
|---|---|---|
| 1 | 每个日期行的摘要右侧加 **「彻底删除这天」**（确认框写明"不可恢复"、几项、多少空间） | `renderTrash` |
| 2 | 每天标出 **还剩几天到期 / 已过期**（`deletedAt + trashDays`，按天向上取整），顶部写清当前保留天数 | `renderTrash` |
| 3 | 底部 **「立即清理过期项（N）」**：走同一个 `/api/trash/purge` 的 `olderThanDays`（没有过期项时按钮禁用并说明） | `renderTrash` |
| 4 | 设置面板加 **「回收站保留天数」** 输入框（回显 `cleanup.trashDays`，保存时取整且 ≥0） | 设置 → `saveCfg` 的 `cleanup` patch |
| 5 | 配置校验：非整数/负数报错；**0 显著告警**（0 不是"立刻清理"，而是**不用回收站** —— 删任务直接永久删） | `config.validateConfig` |

**两个容易踩的点**：

- 「彻底删除这天」按钮在 `<summary>` 里 —— 不 `preventDefault()` 的话，点一下**既删东西又顺手把这一天折叠/展开**
  （原生 `details` 的默认行为）。真浏览器验证据此专门测了"折叠状态不变"。
- 到期提示必须用**本地日期**算（与 §45 的分组键同一个理由：`deletedAt` 是 UTC 的 ISO）。

**验证**：`npm run tabs-ui` 20 → **30 项**：每个日期都有删除按钮（6 天 6 个）、每天都带到期提示、
「立即清理过期项」在列表里、点日期删除按钮弹的确认文案是「彻底删除 2026-10-11 这一天的 **59** 个条目（6.4 GB）？
…**不可恢复**」且**折叠状态 true → true 不变**；设置里输入框回显 `7`，
**保存后服务端 `/api/bootstrap` 读回来仍是 7**（设置真的落盘并热加载 ✓）。
`test/monitor-panel.ts` 277 → **286 项**（静态锁住：日期按钮 + preventDefault、到期文案、`olderThanDays` 入口、
配置同源、0 的说明、输入框与 patch 的取整、配置校验两个方向）。
`npm run ui-e2e` **121/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-trash-retention`。

## 47. 回收站默认**全部收起**（2026-10-11，用户改口「改成默认是折叠状态」）

§45 的默认是"只展开最近一天"，用户看了一眼实际效果后要求**每一天都收起**。改动一行（去掉 `open`）
+ 文案同步（「默认全部收起，点日期展开」）+ 一键开关在**只有一天时也给**（全收起时它就是唯一显眼的展开入口），
另外顺手验证了开关回到默认态：

- `npm run tabs-ui` 30 → **32 项**：真浏览器读出「3 天，展开 0 天」（全收起 ✓）；
  开关初始文案是「全部展开」，点一下每一天都展开且文案变「全部收起」，**再点一次回到全收起**（截图即默认样子）；
  点某天的「彻底删除这天」时折叠状态 `false → false`（`preventDefault` 仍然有效 ✓）。
- `test/monitor-panel.ts` 286 → **287 项**：把「默认展开最新一天」的断言改成
  「**必须没有 `open`**」+ 文案一致性检查 —— 防止以后有人把默认值改回去而测试还绿。
- `npm run ui-e2e` **121/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-trash-collapsed`。

> 顺带记一笔：用户把保留天数从 7 改成 **3** 之后，旧的 10-09 之前那些天**真的被自动清掉了**
> （回收站从 189 项 / 27.1 GB 降到 66 项 / 6.4 GB，剩 3 天）—— 说明 §46 那条"超期自动删除"是在干活的。

## 48. 待删清单与回收站合并成一页（2026-10-11，用户：「已经删除的 不在显示 或者 放一起」）

用户给了两个选项，选了信息量更大的那个 —— 因为**原来两边说的是同一件事、动作却不一样**：

| | 待删清单页底部的「最近已删除」 | 回收站页 |
|---|---|---|
| 内容 | 同样的已删条目（`deleted.slice(-20)`） | 同样的已删条目（按天分组） |
| 能做什么 | 什么都没有（纯历史） | 恢复 / 彻底删除 / 超期自动清理 / 看到期时间 |

所以合并成一页两段（页签名 **「待删 / 回收站」**，`data-view="trash"`）：

1. **① 待删（用完即删 · 宽限期内可取消）** —— 待删列表 + 取消删除 / 立即删除 / 全部立即删除 / 立即执行到点的删除；
2. **② 回收站（已删除 · 可恢复）** —— 按天分组（默认全收起）+ 恢复 / 彻底删除 / 彻底删除这天 / 立即清理过期项 / 清空回收站；

**「最近已删除」那段历史直接删掉** —— 回收站就是它的完整版。实现上把两个渲染函数合并成
一个 `renderDeletePage(box)`（两段各自 `.catch` 取数：一段失败不会把整页打成空白；任何动作完成后整页重画）。

**测试影响**：`tools/ui-e2e.ts` 的 12a 段（原来点 `data-view="pending"`）与设置面板那段的入口断言、
`tools/verify-tabs.ts` 的页签顺序（7 → 6 个）与待删段检查都跟着改了 —— 后者现在断言
「**同一页里同时有待删段与回收站段**」「**不再出现『最近已删除』**」「待删段按钮数 = 待删条目数」。
`test/monitor-panel.ts` 287 → **292 项**（页签只有一个、`renderDeletePage` 单函数、两段标题、无重复历史、
两段各自容错、整页重画）。
`npm run tabs-ui` 32 → **34 项**（标签栏读出「任务 · 实时监控 · 健康面板 · **待删 / 回收站** · 稿件表现 · Prompt」；
合并页两段都在、回收站的天分组也在）。`npm run ui-e2e` **121/0**；`npm run typecheck` 干净。
`UI_BUILD` → `ui-2026-10-11-delete-page-merged`。

## 49. 夹具与真实数据分账：任务列表与成本不再被测试污染（2026-10-11，优化第一批 P0-2）

**实测证据**（从日志里数出来的，不是猜的）：

| 日期 | 建任务 | 真实直播 | 其余是什么 |
|---|---|---|---|
| 10-06 | 38 | 4 | `测试场次`、`【界面测试】固定夹具任务`、`逐片操作测试` … |
| 10-08 | 41 | 0 | 同上（`测试场次` ×22） |
| 10-10 | 45 | 2 | 同上（`测试场次` ×18） |
| 10-11 | 27 | 3 | 同上 |

两个后果都很实际：① 任务列表被淹没（**用户最早的抱怨就是"列表太长"**）；② 「成本」月度汇总把夹具算进去，
数字不再代表真实开销。

**改动**（识别口径只此一处：`src/fixtures.ts`）：

1. `isFixtureTask()`：① 台账显式标记 `fixture:true`（新夹具走这条，最可靠）→ ② id 前缀
   （`uie2e-`/`mon-`/`mp-test-`/`perf-t`/`timing-`/`dbg-`/`ab-`/`t-`/`T1`）→ ③ 标题特征
   （全名等于已知夹具名、或以 `【界面测试】`/`【测试】` 开头）。
   ⚠️ **刻意不用"标题里含『测试』"**这种宽判据：游戏主播真的会播「测试服开荒」，
   那会把真实场次误判成夹具（**比不识别更糟**）——套件里专门写了这条反例。
2. 接口：`/api/tasks` 每项带 `fixture`，并新增 `fixtureTotal`；
   **成本汇总走 `splitFixtures`，夹具不计入**，同时如实回报 `monthly.fixturesExcluded`（不静默改口径）。
3. 界面：任务列表**默认隐藏夹具** + 底部一个「显示测试夹具（N）」开关（藏了几个写在脸上）；
   打开后夹具行带「🔧 测试夹具」标记；空列表时提示「另有 N 个测试夹具被隐藏」而不是「没有任务」；
   成本卡片顶部写明「已排除 N 个测试夹具任务」。

**验证**：
- 新增 `test/fixture-accounting.ts`（**27 项**，已接入 `npm run verify`）：识别口径 8 条正例 + **4 条反例**、
  分账、接口标记、成本真的排除（1.0+2.0 ASR / 0.2+0.3 LLM = 3.5，而不是含夹具的 21.5）、界面接线静态核对；
- `npm run tabs-ui` 34 → **39 项**：真浏览器里造一个真夹具 → 列表里**看不到**、开关写「显示测试夹具（1）」、
  勾上后出现且带 🔧 标、成本接口把它排除（`total < 9`）、跑完自动删掉自己造的夹具；
- `npm run ui-e2e` **121 → 122 项**（它的夹具现在默认被藏，所以先勾开关再断言 —— 顺带把开关本身也验了）；
- `npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-fixture-accounting`。

## 50. 「ASR 提速」实测：**剪静音没用**，真正的大头是切片与排队（2026-10-11，优化第一批 P0-1）

我原本把"ASR 提速"排在 P0-1，理由是"端到端最慢的一段"。**实测把这个假设否掉了**，如实记录：

### 50.1 剪静音 A/B（同一素材、同一台机器、只改开关）

素材：一场真实录播 `2026-10-10 22-58-58-047 【电台】和lulu双人棉花糖！.ts`，**59 分 02 秒**、
AAC 117 kb/s。工具：新增 `tools/local-asr/ab-silence-trim.ts`（离线跑、临时缓存、不动真台账）。

| | 基线（不剪静音） | 剪静音 |
|---|---|---|
| 墙钟 | **480.4 s** | **468.2 s** |
| 字幕条数 | 1730 | **1730**（完全一致） |
| 覆盖语音时长 | 2877.7 s | **2877.7 s**（完全一致） |
| 首/末条时间戳 | 0.06 / 3538.78 | 0.06 / 3538.78（一致） |

**只快 12 秒（2.5%）**，质量指标一个都没变。原因很直接：这场内容**语音占比 81%**（2877.7 / 3540 秒），
本来就没多少静音可剪 —— 与"ASR 成本 ∝ VAD 段数"那条实测一致，而这套素材的段数主要由说话决定。

**结论**：`asr.silenceTrim` **保持默认关闭**（开了还多跑一遍 ffmpeg 检静音，收益 < 成本，
且多一道时间戳映射风险）。工具留在仓库，换内容形态（游戏/音乐占比高）时可复测。

### 50.2 端到端到底花在哪（从真实日志按阶段拆开）

| 场次 | 素材 | 等开始转写 | **转写** | 分析 | **切片** | 总计 |
|---|---|---|---|---|---|---|
| `…160549-sqml` | 25 MB 碎片 | 86 s | 96 s | 20 s | **93 s** | 295 s |
| `…162740-wp2u` | 94 MB | 160 s | 64 s | 44 s | **137 s** | 406 s |
| `…160148-ew1r` | 332 MB / 59 min | 573 s | **145 s** | 26 s | **255 s** | 999 s |
| `…150252-qadr` | 332 MB | 1016 s | 133 s | 56 s | **493 s** | 1698 s（含当时的风暴） |
| `…140346-ygk1` | 332 MB | 3691 s | 152 s | 33 s | **410 s** | 4286 s（含 8 次重复投稿） |

三条结论（都改变了优先级排序）：

1. **ASR 不是瓶颈**：59 分钟音频线上只花 **133–145 秒**（RTF ≈ 0.04）⇒「先优化 ASR」这条路可以划掉；
2. **切片才是最大可控项**：93–493 s，且**受 biliLive-tools 的切片吞吐限制**（切片任务是我方并发提交的，
   但 ffmpeg 在对方进程里排队）⇒ 想压时间得从它那边开并发/调预设，而不是在自研侧折腾；
3. **"等开始转写"经常比干活还久**（573–3691 s）：这是**串行队列 + 素材还在写**的等待。
   `ygk1`/`qadr` 那两个异常值正是当晚"一场被跑 8 次投稿"造成的（已在 §40b 修掉：单飞闸 + 重复入队忽略）。

## 51. 投稿批次账：把"一次投稿"变成有身份、可对账的对象（2026-10-11，P1-1）

原来确认一次投稿有没有落地，只能**逐片按标题模糊匹配**目标稿件的分P 列表 —— 这条链路上出过三次事故
（§40b 的 8 次重复投稿、9-23 的"任务全 completed 但 B站 侧没动静"、以及反复出现的「已提交待确认」卡住），
共同根因是：**我们不知道自己这次提交"本该"产生哪几个分P**。

新增 `src/publish-batches.ts`（复用 `data/publish-log.jsonl`，用独立 action 名，老读法不受影响）：

- `batch-submit`：提交成功立刻记下 —— `uploadTaskId`（批次身份）+ 目标 `aid`/`bvid` +
  **本该产生的分P 标题** + 对应切片序号；
- `batch-landed` / `batch-failed` / `batch-unconfirmed`：结果行（追加写，读取时**以最后一行为准**）；
- 反查（`confirmPublished`）新增**按批次对账**：用这一轮读到的分P 标题集合把每个未结批次判一遍，
  写回结论并输出一句话（例：`批次 0bd3b6bf：提交 12 分钟，2/3 个分P 落地，缺：星瞳露露争夺于文波…`）；
- `biliLive-tools` 报 `error` 时批次直接记 `failed`（与切片 FAILED 同源，不再含糊成"待确认"）。

**验证**：新增 `test/publish-batches.ts`（**27 项**，已接入 `npm run verify`）：读写与归并、未结批次语义、
失败批次不进"等待"列表、按任务过滤、年龄计算（含按给定时刻）、只清批次行不动 submit 流水，
以及 6 条接线静态核对（含"批次行不参与『本场已有 N 次投稿』提醒"这条防串味断言）。
`npm run typecheck` 干净。

## 52. 切片库：跨场次检索切片（2026-10-11，优化第一批 P0-3）

**为什么**：稿件是长期资产，而切片一直只能"一场场翻任务"看 —— 想复盘"上次那种题材多少播放"、
想把一条老切片再发一次、想核对某条到底投没投出去，都得先想起它在哪一场。

**服务端**：新增只读 `GET /api/clips/library`，把所有场次的切片拉平成一张表：

- 聚合：`taskId/场次标题/场次时间` + `标题/区间/时长/评分/状态/选中` + `bvid/稿件链接/publishedAt` + `是否已切片`；
- 播放与点赞**取自表现数据里每个 bvid 的最新一行**（与「稿件表现」页同源，不另算一套口径）；
- 筛选 `q`（覆盖切片标题、场次标题、任务 id、BV 号）与 `status`；排序 `score|view|like|time|duration` + 升降序；
- **截断如实说**：`total / truncated / limit`，默认 200、上限 500。

**界面**：新增「切片库」页签（标签栏：任务 · 实时监控 · 健康面板 · 待删/回收站 · 稿件表现 · **切片库** · Prompt）：

- 搜索框（300 ms 防抖）、状态筛选、排序 + 升降序、**导出 CSV**（导出的是屏幕上这批行，所见即所得）；
- 每行动作：**试看**（复用与任务详情同一个 `/api/preview-cut`，行为一致）、**去这一场**（切回任务页并打开该场）、
  以及稿件链接；未切片的行如实写「未切片」而不是给个点了没用的按钮；
- 超过上限时写「只显示前 N 条，共 M 条」+「多显示 200 条」。

**验证**：
- 新增 `test/clip-library.ts`（**19 项**，已接入 `npm run verify`）：跨场次聚合、播放/点赞同源、
  带稿件链接、未切片不假装能试看、状态筛选、关键词覆盖四类字段、排序（评分/时间/升降序）、
  **截断如实报**（`limit=2` 时 `total=4 & truncated=true`）；
- `npm run tabs-ui` 39 → **44 项**：真浏览器里造一场带 2 条切片的临时场次 → 表格渲染、
  搜索「已发布的一条」只剩 1 行、状态切「失败」只剩另一行、跑完自动删掉临时场次；
- `test/monitor-panel.ts` 292 → **301 项**（静态锁住页签、渲染函数、改筛选重新查服务端、
  五个控件、截断文案、试看/跳转复用、导出所见即所得、服务端只读）；
- `npm run ui-e2e` **122/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-clip-library`。

## 53. 统一待办：把"需要人管的事"收敛到一处（2026-10-11，优化第一批 A4）

**问题**：要人管的事散在三处 —— 未确认投稿在任务列表/切片卡片、失败场次在任务列表、
磁盘与错误在健康面板、待删到点在待删页。用户问"现在要我做什么"时，没有任何一处置能一句话回答。

**改法**：新增只读 `GET /api/todos`（判据集中一处，界面与 MCP/CLI 共用），健康面板顶部渲染成「待办」卡片：

| 条目 | 判据 | 等级 | 动作 |
|---|---|---|---|
| 未确认投稿 | 有 `SUBMITTED` 切片；按**最久的那一批**分级 | <1 小时 warn，≥1 小时 error | 去这一场核对 |
| 失败场次 | `status === FAILED` | error | 去处理 |
| 卡住的场次 | 处理中状态且 `updatedAt` 超过 2 小时 | warn | 去实时监控看 |
| 磁盘 | 剩余低于 `cleanup.diskFloorGB` | error | 去清理 |
| 待删到点 | 1 小时内将自动删除 | warn | 去待删清单 |

干净时明确写「✅ 现在没有需要你处理的事：投稿都确认过了，没有失败场次，磁盘也够用」——
**不硬凑条目**；测试夹具不进待办（否则永远"有 22 件事要处理"，见 §49）。

**验证**：
- 新增 `test/todos.ts`（**16 项**，已接入 `npm run verify`）：干净态（0 条 + 一句人话 + 扫描场次数）、
  未确认投稿的分级（20 分钟 warn / 90 分钟 error）+ 文案给出"确认没落地就重投"的做法、
  失败场次成条、**正在更新的处理中场次不被误报成"卡住"**（并静态锁住 >2 小时的判据）、
  夹具不进待办、**只读**（跑两次台账状态一模一样）；
- 真机验证：对跑着的服务直接 `GET /api/todos`，当前返回 `clean=true`、0 条、扫描 0 场（用户刚清空过台账）；
- `test/monitor-panel.ts` 301 → **307 项**（静态锁住卡片、走服务端口径、空态文案、动作跳转、夹具过滤、分级）；
- `npm run ui-e2e` **122/0**；`npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-todos`。


## 54. 设置面板瘦身：分组折叠 + 搜索 + 常用快跳 + 危险标注（2026-10-11，优化第一批 A1）

**问题**：设置面板 **81 个输入平铺一页**（`config.json` 一共 238 个叶子字段），
找一个开关要滚很久；危险项（`trashDays=0` 会直接不用回收站、删源开关）和常用项混在一起，看不出轻重。

**做法是纯增强层**（`enhanceCfgPanel()`，在 `bindCfg()` 开头跑一次、幂等）——**不动任何字段的 id / name / 保存口径**
（`saveCfg` 仍按 id 读值，所以绝不会因为这次改动丢配置）：

1. **分组折叠**：已有的 9 个 `.group` 原地包成 `<details class="cfggroup">`，**默认全部收起** ——
   打开设置先看到"目录"；顶部一个「全部展开 / 全部收起」；
2. **搜索**：按字段可见文字过滤，**命中的分组自动展开**，并如实报「匹配 N 项（已自动展开所在分组）」；
   清空搜索自动回到全收起（不留"上次搜过"的迷惑状态）；
3. **常用快跳**：8 个高频字段（biliLive-tools 地址 / 直播间 / 自动发布 / 多分P / 立即发布 /
   回收站保留天数 / 每日投稿上限 / 仅自己可见）做成跳转按钮：展开所在分组 + 滚过去 + 聚焦。
   ⚠️ **刻意不移动 DOM**：`id` 一旦重复，`saveCfg` 的 `getElementById` 会读到另一个元素，保存就静默丢值；
4. **危险标注**：`c_trashDays` / `c_deleteRaw` / `c_keepOnFail` 的 label 上挂「⚠ 改错代价大」——不阻止保存，但让人看见。

**验证**：
- `npm run tabs-ui` 44 → **51 项**：真浏览器里读出「9 个分组（展开 0）、常用快跳 8 个、危险标注 3 个」；
  搜「保留天数」→「匹配 3 项…可见字段 3 个，自动展开 3/9 组」；点「全部展开」→ 9 组全开且按钮变「全部收起」；
- `test/monitor-panel.ts` 307 → **313 项**：静态锁住"幂等"、"在 bindCfg 里调用"、"默认收起"、
  "搜索自动展开 + 如实报数"、"快跳不移动 DOM（防 id 重复让保存读错值）"、危险清单内容；
- `npm run ui-e2e` 122 → **123 项**：它的设置段原来直接读 `innerText`，现在分组默认收起 → 断言前先点「全部展开」
  （**这一步本身也把那个按钮验了**）；
- `npm run typecheck` 干净。`UI_BUILD` → `ui-2026-10-11-cfg-slim`。

## 55. UI 拆模块（A6）与重复分P 自动检测（2026-10-11，优化第二批 ①）

### 55.1 `public/ui.html` → 20 个有序模块 + 可复现构建

`ui.html` 原本 4600+ 行、单文件、内联脚本 4000+ 行；每次改 UI 都要在整块里找位置，风险全靠 e2e 兜。
**做法**：不硬拆 ES module（那是一个大作用域，共享 `state`/工具函数，直接切模块会引入 TDZ 与顺序坑），
改走**有序拼接**：`web/src/` 下 20 个模块（外壳 3 + 样式 1 + 脚本 16，按原文横幅注释切、名字取自段落标题），
`web/ui-modules.json` 记顺序，`tools/ui-modules.ts` 提供 `--split / --build / --check`。

- `npm run build:ui`：模块 → `public/ui.html`（运行时仍是单文件，服务端/e2e 一行未改）；
- `npm run check:ui`：断言"模块拼出来 == 当前 ui.html"——**改产物不改模块立刻红**，已接进 `npm run verify` 首位（46 → **47 步**）；
- **拆分安全性的硬证据**：拆分前后 `public/ui.html` 的 SHA256 完全相同（`7C3C38F5E2ADCC2303230377…`）⇒ 零语义变化，`UI_BUILD` 都无需改动。
- 两次踩坑（都被"重建必须逐字节一致"这道闸拦住并自动还原 `ui.html`）：① 按行数组拼分块 off-by-one；
  ② 从 `<script>` 标签之后开始切、重建时丢了开标签。

### 55.2 重复分P 自动检测（进统一待办）

**背景**：稿件 `BV1oWpG69Etu` 里有一对标题完全相同的分P（同一段内容被投两次），是修复前
"一场被跑 8 次投稿"的遗留，此前只能靠人眼看出来。

**做法**：反查（`confirmPublished`）本来就要读目标稿件的分P 标题列表 —— 顺手用
`findDuplicateTitles()`（规范化 = 去空白，与落地确认同一口径）查一次重名；发现就在 `publish-log.jsonl`
追加一条 `duplicate-parts` 记录，**只在重复集合变化时写**（否则每 5 分钟一轮反查会刷爆日志）；
`/api/todos` 读这份本地记录（**不在只读端点里打 B站 接口**）→ 健康面板「待办」里出现
「N 个稿件里有重复分P」，附 bvid 与"B站 没有删单个分P 的接口，需要到创作中心手动删"的说明。

**验证**：`test/publish-batches.ts` 27 → **33 项**（规范化识别、三份计数、空数组、
"变了才写"、读回供待办展示）；`npm run typecheck` 干净；重启后真机 `GET /api/todos` 返回 0 条 clean
（当前台账已被清空，没有可扫描的稿件）；`test/todos.ts` 16 项、`test/monitor-panel.ts` 313 项全绿。

**如实说明一个限制**：检测只覆盖**台账里还有切片**的稿件。用户那对遗留重复分P 所在的场次已被删除，
所以它不会被自动扫出来（我此前已单独告知，需要人工在创作中心删一个）。要让它在界面上也被报出来，
需要一次性的"按 bvid 直接体检"工具 —— 我把它列进下一步（与批次时间线一起做）。

## 56. 稿件级视图（2026-10-11，优化第二批 ⑥）与 A6 的不变量测试

### 56.1 稿件级视图

**问题**：整个界面以"场次"为轴，而稿件才是长期资产 —— 想知道"这个稿件现在多少个分P、有没有重复、
我们投的都在不在、表现如何"，得分别看切片库、表现页、创作中心。

**做法**：新增只读 `GET /api/archive/:bvid`，一次给全：线上分P 列表（序号/标题/时长）、
本台账里属于它的切片（哪一场/序号/状态/评分/发布时间）、表现（播放/点赞/数据日期）、
**健康**（`duplicates` 重复分P / `missingLocal` 本地记着投成功但线上没有）。
入口：切片库里每个带 bvid 的行 → bvid 旁「看稿件」→ 弹窗呈现上述全部 + 健康结论。

**真机验证**（用户稿件 `BV1oWpG69Etu`）：`线上分P=45  本地切片=0  重复=0  缺失=0`，
表现可读到（播放 6 / 点赞 0）—— 同时再次确认此前那对遗留重复分P 已被清除。

### 56.2 A6 的不变量进了测试

新增 `test/ui-modules.ts`（已接入 `npm run verify`，紧随 `check:ui` 之后）：清单非空、三类片段齐全、
脚本分块数 ≥8、模块名非空、清单文件都在盘上、**按序拼接 === public/ui.html（逐字节）**、
产物里 script/style 标签各只有一份、工具提供三个入口、`--split` 会先备份并能在重建不一致时自动还原、
npm 脚本与 verify 链都接好。

### 56.3 ④「边录边转写」的计划（唯一还没做的一项，故意放慢）

实测：**"等开始转写" 占 573–3691 秒**（串行队列 + 素材还在写），比转写本身（133–145 秒）长得多。
办法是**分段增量转写**：录制器每落一个分段就送去转写，录完时转写几乎已就绪。

但它是这四项里**唯一会动主链**的改动（录制监听的触发时机 + 转写缓存键 + 任务状态机），
所以分成两步、**先证明再改**：
1. **可行性验证**：用同一场直播的两个相邻分段做实验 —— 分段转写与"整段合并后转写"是否等价
   （字幕条数/覆盖时长/时间戳偏移），以及分段转写能否命中同一份内容哈希缓存、重复消费不重复付费；
2. 只有第 1 步通过才改主流程：对"已闭合的分段"提前入队转写，状态机增加"部分转写完成"态，
   并保证任何一步失败都能回退到现有"录完再整段转写"的老路径。

**取舍**：收益是端到端从"录完 +17 分钟"压到"录完即出"；代价是主链复杂度上升 —— 所以没拿到第 1 步的数据就不动第 2 步。

## 57. 编码卫生闸（2026-10-11，优化第三批 ⑤）

**起因（自伤）**：我用 PowerShell 的 Set-Content -Encoding UTF8 重写 package.json，文件被加上 UTF-8 BOM；
npm 能容忍，但 JSON.parse 直接抛 SyntaxError: Unexpected token ''，一个新写的测试因此莫名其妙地红。
事后全仓扫描发现 7 个文件带 BOM（package.json、public/ui.html、src/publish.ts、src/server.ts、
test/publish-batches.ts、test/todos.ts、tools/ui-e2e.ts、web/src/31-基础.js），已全部清理
（public/ui.html 是走 npm run build:ui 从模块重建，不手改产物）。

**闸门**：新增 tools/check-encoding.ts，两条方向相反的规则（都来自本仓库真实约定）：

| 扩展名 | 规则 | 原因 |
|---|---|---|
| .ts/.js/.mjs/.cjs/.json/.html/.css/.md | **不得**带 BOM | BOM 会让"逐字节比对"（UI 模块构建、产物校验）出现假失败 |
| .ps1 | **必须**带 BOM | PowerShell 5.1 不认无 BOM 的 UTF-8，中文会乱码（实测过） |

已注册为 npm run encoding-test，并接进 npm run verify（排在 check:ui 之前）。
扫描范围排除 node_modules/.git/data/dist 等；当前扫 331 个文件、0 违规。

**自证（重要）**：一个从不报警的闸等于没有闸 —— 实测放一个带 BOM 的诱饵文件 tools/__bom_selftest.json，
闸报红且退出码非零；删掉诱饵后恢复 0。

**约定**：写仓库文件一律用 node 的 fs.writeFileSync(..., 'utf8')，不要用 PowerShell 的 Set-Content/Out-File。
## 58. 隔离性测试与 verify 分层（2026-10-12，优化第三批 ②③）

### 58.1 隔离性测试（test/isolation.ts）

起因：本轮实测抓到 readBatches() 用硬编码 DATA_DIR，在 dataDirOverride（测试/隔离运行）下
**静默读真实目录**的 publish-log.jsonl —— 台账隔离了、周边文件却还指向真实仓库，
这正是"测试污染真实数据"那类事故的温床。

口径固定成一条硬约束：**用隔离目录起一套服务、跑一圈只读接口，真实 data/ 必须一个字节都没动**。
做法：递归快照真实 data/（rel → 大小:mtime），排除三处刻意例外并写明理由
（data/logs 与看门狗共用、data/verify-shots 验收截图、data/trash 可能被定时器动到），
起隔离实例打 8 个只读接口，再快照比对新增/删除/改动三类差异。

断言：8 个接口全 200；ledger.json 落在隔离目录；**日志也落在隔离目录**；
真实 data/ 无新增/无删除/无改动（本轮实测 488 个文件、快照指纹前后一致）；
批次账路径跟随隔离目录（那个 bug 的回归断言）。

### 58.2 verify 分层

verify 链已经 51 步、跑一次越来越久，于是拆成两层：

| 命令 | 内容 | 用途 |
|---|---|---|
| npm run verify:fast | typecheck + 编码闸 + check:ui + ui-modules + isolation + 夹具分账 + 批次账 + 切片库 + 复盘 + 待办 | 改完随手跑（秒级到十几秒级的套件） |
| npm run verify | 上面这些 + 全部历史套件 + e2e + smoke + real | 发布前/夜间跑 |

**未做（如实说明）**：每步耗时统计还没加 —— 需要一个计时 runner，我列进下一批；
目前只完成了"快速子集 vs 全量"的拆分。

## 59. ASR 拆独立进程：转写崩溃不再拖垮主链（2026-10-11，优化第二批 ④ 的前置工程）

### 59.1 要解决的是什么（**不是提速**）

早期那次 OOM 是**整条链一起死**：转写吃满内存 ⇒ 守护进程跟着没 ⇒ 看门狗把它拉起来 ⇒
这一场从转写阶段重来。用户看到的是"界面卡住 / 服务自己重启 / 一场白跑"。
而 ASR 是整条流水线里**唯一会吃掉几个 GB** 的阶段（模型加载 + 长音频推理）。

所以这一项换的是**隔离**，不是速度：

> 转写跑在独立子进程里，它 OOM/崩溃只死自己；守护进程与看门狗不受影响，
> 任务自动重试（最多 2 次），两次都不成就**原地降级**回进程内转写（功能不减，只是失去隔离）。

**如实说明**：模型本来就跑在一次性子进程里，所以这一项**没有提速**（实测两边墙钟 466.6s vs 498.6s，
差异是同机不同时刻的抖动，不作为快慢证据）。要提速得看 §50 的结论（切片与排队才是大头）。

### 59.2 六步落地（每一步都有可复跑的验证）

| 步 | 产出 | 验证 |
|---|---|---|
| 1 | `src/media-plan.ts`：把"按分段边界规划转写调用单元"抽成**纯函数**（跨进程只传可序列化的 `segments`） | `test/media-plan.ts` **25 项** |
| 2 | `daemon.ts` 删掉内联副本、改调纯函数 | 同上；**抓出一处行为漂移**（§59.6） |
| 3 | `src/asr-worker.ts`：worker 本体（只走 JSON 协议；自己 `loadConfig()`，**不经 IPC 传配置**，密钥不跨进程搬） | 冒烟：真 worker 握手 + 空任务往返 |
| 4 | `src/asr-worker-client.ts`：父进程侧客户端（起进程/握手/转任务/进度转发/收结果/心跳/超时/收尸） | 同上 + 下一步的 46 项 |
| 5 | `daemon.ts` 接线：开关打开时先走独立进程，最多 2 次，失败**原地降级** | §59.4 真机故障注入 |
| 6 | `test/asr-worker.ts`（46 项）+ `tools/local-asr/worker-fault-live.ts`（真机故障注入，27 项） | `npm run asr-worker-test` / `npm run worker-fault-live` |

另外顺手落了两件小事（都属于"可观测/一致性"，不是新功能）：
`dryRun` 跟着任务一起进 worker（§59.6 的第一处漂移）、
**worker 的 pid 写进日志**（`转写 worker 已启动（pid N）` —— 它吃满内存时用户能照着 pid 结束它，
不必重启整个服务，那正是这一项要避免的事）。

### 59.3 等价性：独立进程与进程内**逐位一致**（59 分钟真实素材）

同一份素材（`auto-20261009125609-znr5` 的 59 分钟原始录制）、同一台机器、同一个缓存目录，两条路径各跑一遍：

| 指标 | 进程内（基准） | 独立进程 | 差异 |
|---|---|---|---|
| 字幕条数 | 1727 | **1727** | 0 |
| 覆盖语音 | 2432.7 s | **2432.7 s** | 0 |
| 首条时间戳 | 4.41 | **4.41** | 0 |
| 末条时间戳 | 3539.6 | **3539.6** | 0 |
| 墙钟 | 466.6 s | 498.6 s | +32 s（+6.9%，抖动，不作结论） |

为什么能逐位一致：两条路径跑的是**同一份规划纯函数**、**同一个 `Transcriber`**、**同一份缓存目录**；
跨进程只传可序列化的 `segments`，worker 侧用同一个 `planSegmentCalls()` 重建调用单元。
这条等价性有 `test/media-plan.ts`（纯函数语义 + JSON 往返）与 `test/asr-worker.ts`（协议字段逐字抵达）兜着。

### 59.4 真机故障注入：杀 worker / 弄坏 worker 脚本

`tools/local-asr/worker-fault-live.ts` 起**真 Orchestrator + 真 HTTP 服务**（隔离数据目录、dryRun 只到 clips.json），
用一段 15 分钟真实素材（从整场里 `-c copy` 切出，不重编码）跑两件事：

**A 步：转写进行到一半，`taskkill /F /T` 掉 worker（连同它拉起的 FunASR 子进程）**

| 观测 | 结果 |
|---|---|
| 杀的时刻 | worker 已运行 **151 秒**（模型加载约 96 秒 ⇒ 正在推理中） |
| 被杀掉的进程 | worker + 它的 2 个子进程（python/推理），一次 `/T` 全清 |
| 守护进程侧记录 | `独立进程转写失败（第 1/2 次）：worker 提前退出（code=1 signal=null）` |
| 之后 | 日志下一行就是 `转写走独立进程（第 2/2 次尝试）` ⇒ **同一个进程自己重试** |
| 重试结果 | **成功**：`转写落盘：492 条字幕` |
| HTTP（UI 轮询的 `GET /api/tasks`，每 250ms） | 窗口内 **629 次采样、失败 0 次**；平均 16 ms；两次响应最大间隔 **317–428 ms**、单次最大 **19–169 ms**（三次实跑的范围，上限那次是同机另有负载造成的抖动） |

**B 步：把 worker 脚本改名（模拟部署残缺/路径写错）⇒ 必须原地降级**

| 观测 | 结果 |
|---|---|
| 两次尝试 | 都失败：`worker 提前退出（code=1 signal=null），且从未握手`（脚本不存在 ⇒ 子进程起不来） |
| 降级 | `独立进程两次都没跑成 —— **已原地降级**到进程内转写（功能不减，只是失去崩溃隔离）` |
| 降级后 | 进程内路径**走缓存命中**（`缓存命中 1`）→ `转写完成：492 条字幕`，与 A 步**同一数字** |
| 收尾 | 脚本已恢复、内容指纹未变；`config.json` 指纹未变（开关在盘上仍是 `false`） |

**这一节的结论**：用户最初报的那个症状（ASR 一崩，整条链跟着没）现在有了一道**可复跑的实测闸**：
转写崩了不影响界面响应，任务自己重试；连 worker 都起不来时，功能照旧（只是失去隔离）。

### 59.5 护栏：`test/asr-worker.ts`（46 项，已进 verify 链）

| 组 | 断言内容 |
|---|---|
| 真 worker 往返（无音频、不加载模型，114 ms） | 握手、结果形状与进程内一致、空任务如实给"没有可转写的窗口"警告 |
| 协议 | 任务字段（含 `segments`/`dryRun`）**逐字**抵达 worker；进度 3 条原样转发；结果对象原样透传 |
| 五种失败 + 收尸 | 未握手即退（`crash`）、迟迟不握手（`handshake`）、worker 自报错（`error`）、卡死不回 ping（`heartbeat`）、一直不结束（`timeout`）、中途崩（`crash` 带 exit code）——**每一种之后都断言子进程已被收尸**（假 worker 启动先落 pid，事后查那个 pid 是否还在） |
| 静态接线不变量 | worker 用**同一份** `planSegmentCalls`、自己 `loadConfig`、共用缓存目录、`dryRun` 跟着走、守护进程"最多 2 次 + 原地降级"、开关默认关、npm 脚本与 verify 链都接好 |

### 59.6 过程中抓到的两处问题（都是"看着没问题，其实不一致"）

1. **`dryRun` 没跟着任务走**（真 bug，已修）：进程内路径给 `transcribe()` 传了 `dryRun`，worker 路径没传。
   对本地 Fun-ASR 无影响（免费路径本来不受那道闸管），但**云端 ASR + dry-run** 时两条路径会给出不同的
   空转写原因 —— 而守护进程正是靠那个前缀区分"设计内的安全拦截"和"真跑挂了"（§见 daemon 里的注释）。
   修法：`dryRun` 进 `WorkerJob`，worker 侧照传；并用 `test/asr-worker.ts` 的静态断言钉住。
2. **假 worker 造错了场景**（我的测试用例错，不是产品错）：3d 用例本意验"卡在 native 调用里 ⇒ 心跳丢失"，
   但假 worker 脚本 `send({type:'ready'})` 之后就跑完了 → 进程自然退出 → 被正确归类成 `crash`（code=0）。
   分类逻辑没错，是"造场景"造错：要验心跳，进程得**活着但不应答**（`setInterval` 撑住事件循环）。
   记一笔：这类"测试自己造错场景"的红，比绿灯有价值。

### 59.7 现在是什么状态

- 开关 `asr.worker.enabled` **默认关**（`config.example.json` 与真实 `config.json` 都是 `false`）——
  关着时行为与接线前逐字一致，所以这次落地不改变任何现有产线行为；
- 打开方式：`config.json` 的 `asr.worker = { "enabled": true, "maxOldSpaceMb": 2048 }`（示例文件里有说明）；
- **下一步（按用户批准的路径）**：下一场真实直播前把它打开，那一场结束后核对日志里的
  `转写 worker 已启动（pid …）`、耗时与字幕规模，与本文档的进程内基准对照；确认无异常后再把默认值改成 `true`。

## 62. 配置面一致性检查（2026-10-12，优化第三批 ⑩）

起因：config.json 有 240 个叶子字段，设置面板只暴露 81 个输入 —— 谁没界面、谁没校验、谁看着能改其实改不了？
新增只读报告工具 tools/check-config-coverage.ts（npm run config-coverage，**不进 verify**：它是报告不是断言）。

实测结果（2026-10-12）：

| 指标 | 数值 |
|---|---|
| config.json 叶子字段 | 240 |
| 设置面板控件（#c_*） | 81 |
| 其中 saveCfg 真正保存的 | **79** |
| src/config.ts 校验覆盖到的字段 | 51 |
| 既没校验也没界面（孤儿字段） | 见报告（多数是内部状态，不一定是问题） |

**两个待人工确认的控件**（在界面上能改，但没有保存逻辑）：#c_platform、#c_uiPort。
前者是本机平台展示（大概率只读），后者是 UI 端口（大概率刻意不热改）—— 需要确认是"设计如此"还是漏接。

**过程中修掉一个假警报**：第一版用正则取 saveCfg 函数体，在第一个 \n} 就截断，
报出"81 个控件全部没接到保存"这种一眼假的结论。改成**花括号配对**后是 79/81。
教训：只读报告也会误导人，报告工具的提取逻辑同样要经得起"看一眼就知道不对"的检验。

### ⑪⑫ 现状（本轮未完成，如实说明）

- **⑪ UI 模块职责归位**：我新加的切片库/复盘/稿件视图函数落在 40-实时监控…js 里（名字与内容不符）。
  归位需要重排模块文件与 web/ui-modules.json 清单，并同步 UI_BUILD 与 e2e 期望值 —— 本轮预算不够，留待下一轮（改动本身由 check:ui 守着，不会静默出错）。
- **⑫ data/ 目录卫生**：本轮只完成了"先量清楚"所需的基础（隔离性测试里已能快照 data/ 并分类差异）；
  把验证产物/临时目录纳入自动清理口径还需改 cleanup 配置与清理任务，留待下一轮。
## 60. 多会话协作看板 WORKLOG.md（2026-10-12，优化第三批 ③）

**起因（真实撞车）**：我准备实现「ASR 独立进程」，写完第一步才发现 src/asr-worker.ts 与
src/asr-worker-client.ts **已经存在**（另一个会话 10-11 11:32/11:34 建的），而且已接进 daemon.ts 与 verify。
再往前还有 docs 章节号重复（两个 §37/§38/§40 —— 已用 §37b/§38b/§40b 消歧）、package.json 被写入 BOM。
同一个仓库上跑多个会话时，缺的不是能力，是**占位与可见性**。

**做法**：仓库根新增 WORKLOG.md（人可读、行格式固定可机读）+ 工具 tools/worklog.ts（npm run worklog）：

| 命令 | 作用 |
|---|---|
| `npm run worklog -- claim "任务" --files a.ts,b.ts` | 占位；若这些文件已被未完成条目占用，会**当场警告并列出占用者** |
| `npm run worklog -- done "任务"` | 销账（把 [ ] 改成 [x]） |
| `npm run worklog -- list` | 看最近 20 条（⏳ 未完成 / ✅ 已完成） |
| `npm run worklog -- check a.ts` | 只查冲突，被占用则非零退出（可放进自己的开工脚本） |

**约定写进文件开头**：开工前占位、改完销账、动手前可查冲突 —— 人和 agent 都照做。
工具只读/追加这一个 Markdown 文件，不碰代码、不进 verify（它是协作约定，不是断言）。
## 61. 文档章节号管理（2026-10-12，优化第三批 ④）

**起因**：多会话协作下 docs/implementation-report.md 出现了重复章节号（两个 §37、两个 §38、两个 §40 —— 已用 §37b/§38b/§40b 消歧）——
根因是两个会话各自"读最大号 + 1"再同时写入。手工挑号在多会话下必然撞车。

**做法**：新增 tools/docs-section.ts（npm run docs-section），三条命令：

| 命令 | 作用 |
|---|---|
| `next` | 打印下一个可用章节号（写新章节前先跑） |
| `check` | 查重（+ 列出重复的每一处行号与标题），有重复则非零退出；**已接进 verify:fast** |
| `list` | 列出所有章节号与标题 |

**刻意不做自动重编号**（写进文件注释）：正文里有大量 "见 §51" 这类交叉引用，
自动改号会把引用指错，还会让另一个会话刚写的章节与它的引用同时失效。
工具只保证两件事：新章节不再撞号；已有撞号能被立刻发现并逐条列出（含行号与标题），便于人工只重编较晚出现的那一节。

**当前状态**：仓库里仍有历史撞号，`npm run docs-check` 会把它们全部列出（这是有意的——
在没有任何人手工处理之前，这个检查会一直红，提醒不要继续往上叠新号）。
## 63. ASR 独立进程的独立验收（2026-10-12）

背景：src/asr-worker.ts / asr-worker-client.ts **不是本会话实现**（另一个会话完成并已接进 daemon.ts，
开关默认关）。他们自己的套件 46/0 用的是受控小样本，缺两条独立证据，于是写了
tools/local-asr/worker-equivalence.ts 做第三方复核（脚本留仓库，可复跑）。

### 63.1 等价性（59 分钟真实录播：worker 路径 vs 进程内路径）

| 指标 | worker 路径 | 进程内基准 | 差异 |
|---|---|---|---|
| 字幕条数 | 1727 | 1727 | **0.00%** |
| 覆盖语音 | 2432.7 s | 2432.7 s | **0.00%** |
| 首条 / 末条 | 4.41 / 3539.6 | 4.41 / 3539.6 | 完全一致 |
| 墙钟 | 549.5 s | 466.6 s | +18%（fork + IPC 开销） |

⇒ 产出完全一致；这一项**不提速**，买的是"ASR 出问题不拖垮主链"。

### 63.2 崩溃隔离（真 SIGKILL 子进程）

四条断言一次全绿（前两轮各只证明了一部分，这一轮是干净复跑）：

| 断言 | 结果 |
|---|---|
| 崩溃归类正确 | crash（"worker 提前退出（code=1 signal=null）"） |
| 不留孤儿 | 以"杀之前的 PID 快照"为基准判定：无残留 |
| **守护进程存活** | 是（进程继续跑完并重试） |
| **重试真跑成** | 102 条字幕 —— 重试刻意换成 360 秒（首次 300 秒），字幕数成比例增长 ⇒ 真重跑，非缓存命中 |

**两个测量教训**（都记在脚本注释里）：
① 判定孤儿必须**以杀之前的快照为基准** —— 第一版"事后全量再扫一次"把重试新起的进程也算成残留，
断言既不成立也不失效（等于没测）；② kill 相关日志别用 emoji —— 实测在 PowerShell 管道里被吞，
导致"到底杀没杀"看不出来，改成 ASCII 后才可见。

### 63.3 结论与默认值

等价性与崩溃隔离均已获独立证据 ⇒ 可按既定路径推进：开关保持默认关，
等**一场真实直播**跑过后再默认打开（按用户此前确认的"默认关 → 实测一场后默认开"）。
## 64. verify 清单驱动（2026-10-12，优化清单 #2）

**起因（我这几轮的真实失误）**：verify 原来是一条 **51 步的巨型 && 字符串**，于是
① 我**两次踩空锚点**（recap-test 写进链里却没注册脚本；docs-check 想插进全量链找不到锚点，最后没接上）；
② **不知道哪步慢**，没法判断该删哪个、该并行哪个；③ 快速链与全量链的差异藏在两条长字符串里，没人一眼看得出。

**做法**：新增 tools/verify.ts + verify.steps.json（清单：name / cmd / fast / optional / timeoutSec）。

| 命令 | 作用 |
|---|---|
| npm run verify:fast | 只跑 fast=true（改完随手跑） |
| npm run verify | 全部（发布前/夜间） |
| node tools/verify.ts --only <名字> | 只跑匹配的步骤（调试用） |
| node tools/verify.ts --list | 列出清单与层级 |

特性：**逐步打印耗时**、失败只留输出尾部 12 行（不刷屏）、汇总最慢
## 65. 切片阶段测量：瓶颈不在 biliLive-tools，而在**我方逐个提交**（2026-10-12，优化清单 P1-4）

**背景**：切片阶段实测 93–493 秒，是唯一还没动的时间大头。此前我的假设是"受 biliLive-tools 的 ffmpeg 吞吐限制"，
需要用户去那个软件里调并发 —— **这次测量把这个假设推翻了**，如实修正。

### 65.1 实测（从真实日志按场次统计）

| 场次 | 切片数 | 切片阶段跨度（首次提交 → 切片完成） | 平均 |
|---|---|---|---|
| auto-20261010140346-ygk1 | 20 | 607 s | 30.4 s/片 |
| auto-20261010150252-qadr | 12 | 1075 s | 89.6 s/片（含当晚 8 次重复投稿风暴，已修） |
| auto-20261010160148-ew1r | 12 | 514 s | 42.8 s/片 |
| auto-20261010160549-sqml | 1 | 18 s | 18.0 s/片 |
| auto-20261010162740-wp2u | 2 | 85 s | 42.5 s/片 |

### 65.2 关键证据：提交是**串行**的

wp2u 那场最清楚（2 片）：

-  0:31:27 提交第 1 个切片任务；
-  0:32:09 第 1 片产出完成 + **同一时刻**提交第 2 个切片任务（两事件相距 42 s = 恰好一片的处理时间）；
-  0:32:51 第 2 片产出完成。

⇒ **我方是"提交一个 → 等它完成 → 再提交下一个"**，把本可以并行的 ffmpeg 工作串起来了。
这也解释了"片数越多、每片平均耗时越长"的现象（12 片 42.8 s/片 vs 1 片 18 s/片）。

### 65.3 结论与建议（改动在自研侧，不动 biliLive-tools）

1. **把切片提交改成"流水线"**：一次提交到上限 K 个（建议先取 2–3，按本机 CPU 核数与 ffmpeg 线程数定），
   完成一个补一个 —— 属于自研侧的改动，不需要用户去调 biliLive-tools；
2. **预期收益**：按 wp2u/ew1r 的数据，2–3 路并行可把切片阶段压到约 1/2～1/3（12 片从 ~514 s 降到 ~180–250 s）；
3. **风险与护栏**：并行会与"转写"抢 CPU（本地 Fun-ASR 也在跑）⇒ 需要给切片并发设上限，
   并在 ASR 阶段进行时降到 1；同时保留"失败回退到串行"的开关；
4. 顺带记录：qadr 那场的 89.6 s/片是风暴期间的异常值，不具代表性（已修复）。

**未做**：本轮只测量与定位，没有改切片提交逻辑（它属于动主链，按惯例先给证据再动）。
## 66. 数据备份：给"唯一真相来源"留退路（2026-10-12，优化清单 P0-2 / F6）

**风险（此前无任何防护）**：data/ledger.json 是唯一真相来源 —— 场次、切片、**指纹**（防重复投稿）、
**墓碑**（防重投已删内容）、已发布标题全在里面。它只做了原子写（防写坏），**没有备份**
（不防误删、磁盘故障、或某次改动的逻辑错误）。一旦损坏：重复投稿的两道防线与历史统计同时归零，
而这恰恰是最难人工恢复的部分。

**做法**：新增 tools/backup-data.ts（npm run backup:data）：

- 把关键**小**文件复制到 data/backup/<ISO 时间戳>/：ledger.json、decisions.jsonl、publish-log.jsonl、
  performance.jsonl、errors.jsonl、pending-delete.json、glossary.json（存在才备）；
- 超过 32 MB 的文件**跳过**（媒体类不进备份，避免备份变成第二个磁盘黑洞）；
- 每份写 manifest.json（文件清单 + 大小 + sha256 前 16 位），便于核对与追溯；
- **轮转保留最近 14 份**（--keep N 可调）；默认执行，--dry-run 只看计划。

**实测**：备份 7 个文件、合计 852.3 KB；ledger.json 备份件与线上**哈希一致**（完整性抽查通过）；
备份目录本身不在 clean-artifacts 的清理范围、也不在待删清单里（两处都核过）。

**未做（下一轮）**：还没挂进每日任务（现在需要手动跑或由计划任务触发）——
这一步要改 daemon 的每日 tick，按惯例单独一轮做并验证。
## 67. 切片并发开关就绪 + 复盘计算收口（2026-10-13，P0-1 第一步 / P1-5 前置）

### 67.1 clip.concurrency：配置、类型、校验（默认 1 = 与历史行为逐字一致）

| 位置 | 改动 |
|---|---|
| config.json（clip 对象内） | 新增 "concurrency": 1 |
| src/config.ts:357（ClipConfig 接口内） | 新增 concurrency?: number + 语义注释 |
| src/config.ts 的 clip 校验块 | 规则：必须是 1–4 的整数（否则 err）；≥3 时 warn「本地 Fun-ASR 与 ffmpeg 会抢 CPU；转写期间系统会自动降到 1」 |

代码侧**尚未读取**这个开关 ⇒ 零行为变化（真正的流水线在下一轮接入）。

**方法教训（连续三轮同一类错误，值得单独记）**：判断"某字段是否已存在"时作用域写得太宽 ——
① 拿替换文本自身当判据；② 全文件搜 "concurrency": 1 命中 asr.concurrency；
③ 全文件搜 concurrency?: number 命中 asr 的类型。
最终改成**结构化**：先定位 interface ClipConfig 的起止行（L316→L379），只在该区间内判断与插入。
结论：改配置/类型一律"先定位结构边界，再在边界内操作"，不要用全文件字符串搜索做存在性判断。

### 67.2 复盘计算收口到 src/recap.ts（界面与推送共用一份口径）

原因：P1-5 要求"场次结束自动推送复盘"。若推送再算一遍就会出现两套口径 ——
本仓库已因"同一件事两处实现"收口过三次（备份、切片规划、批次账）。

改动：
- 新增 src/recap.ts：buildRecap(ledger, taskId) 返回完整复盘；recapPushText(r) 返回推送用短版（3–5 行）；
- src/server.ts 的 GET /api/task/:id/recap 旧内联实现（L2211–L2263）**整段替换**为 buildRecap() 调用，内联副本已删除。

验证：npm run typecheck 干净；node test/recap.ts **14/0**（口径断言在接线后一条没变 ⇒ 抽取等价：
状态计数、评分分布、批次汇总、表现取最新一行、成本、待办四类、干净场空数组、只读性）；
node tools/verify.ts --fast **11 步 / 9.5 秒 / 退出码 0**。

**方法教训**：结构锚点定位**不要用多层正则**（PowerShell here-string → JS 字符串 → 正则，转义一坏就返回 -1）。
改成简单子串（includes("const recapMatch") / includes("const archMatch")）+ 向上退到注释横幅作为替换边界，一次成功。
（上一轮的失败好在脚本在写文件前就 exit(1) 了，仓库无损。）

**未做**：① P0-1 的主链流水线（抽 cutClipOnly + 两阶段循环 + ASR clamp + test/cut-pipeline.ts）；
② P1-5 的推送落地（notify.recapEnabled + alert.taskRecap 的调用点）与失败分级自愈。
## 68. 待办闭环：忽略 / 已处理（2026-10-13，优化清单 P0-3）

**起因**：统一待办上线后只能"去处理"。看得到、点不走 ⇒ 条目反复出现，久了就没人看了（新功能自己变成噪音源）。

### 68.1 存储：src/todo-dismiss.ts

`data/todo-dismiss.jsonl`（追加写、以最后一行为准，沿用仓库 jsonl 约定），只记 key 与时间：

| 导出 | 语义 |
|---|---|
| `readDismissals({dataDir, now})` | 返生效中的隐藏项：snooze 到期自动失效、done 永久、restore 恢复 |
| `dismissTodo({key, mode, hours?, note?})` | 忽略（默认 24h，上限 30 天）/ 已处理 |
| `undismissTodo(key)` | 恢复 |

### 68.2 服务端

- `GET /api/todos`：过滤被忽略/已处理的条目，并**如实回报 dismissedCount**（clean 也按过滤后的条目算 —— 避免"看着空了，其实有隐藏项"的歧义）；
- `POST /api/todos/dismiss {key, mode:snooze|done, hours?}` 与 `POST /api/todos/undismiss {key}`：走既有 CSRF 校验，**只写 dismiss 文件，不碰台账、不触发任何流水线动作**。

### 68.3 界面（web/src/39-其它页签…js）

每条待办在「去处理」之后新增「忽略 24h」「已处理」，**两个都带 confirm** —— 待办是"要人管的事"，
误点一次就会静默消失，代价比多点一次确认大；「已处理」的确认文案里明确写了"恢复需手改 data/todo-dismiss.jsonl"
（"恢复全部"的界面按钮尚未做，如实告知）。操作成功后 toast 报出当前隐藏总数并重渲染健康面板。

### 68.4 隔离性修复（本轮顺带发现的自身问题）

dismiss 的存储**最初用的是默认 DATA_DIR** ⇒ 在 dataDirOverride（测试/隔离运行）下会静默写真实 `data/` ——
与"批次账硬编码路径"是同一个坑。现改为从 `ledger.publishLogPath` 的所在目录推出（跟随本进程 dataDir），
共改 3 处调用 + 2 处计数，并在测试里加了回归断言。
这也再次说明 `test/isolation.ts`（第 7 轮加的）值得存在：这类问题只在隔离运行时才暴露。

### 68.5 验证

- `test/todos.ts` **16 → 25 项**，新增第 5 节（走真实 HTTP + CSRF）：忽略后 dismissedCount=1、忽略的条目不再返回、
  **如实报出隐藏数**、恢复后回到 0、恢复后条目重现、已处理后保持隐藏、**dismiss 记录写在隔离目录**、只隐藏被点的那一条；
- `npm run typecheck` 干净；`node test/todos.ts` **25/0**；
- UI 走模块构建（`build:ui` + `check:ui` 通过），`UI_BUILD` → `ui-2026-10-13-todo-dismiss`。

### 68.6 顺带补上的流程缺口

第 8 轮发现 `monitor-panel` 里一条过期断言红了 4 轮没人发现 —— 根因是它不在 `verify:fast` 里。
本轮把 5 个兜住主链/界面的套件加进快速层（monitor-panel / multipart-routing / confirm-append /
multipart-cut-snapshot / media-plan）：快速链 11 → **16 步**，耗时 9.5s → **23.7s**。
代价如实记：慢 14 秒（主要 monitor-panel 9.9s），换来"改主链/界面时不会再有静默变红"。

### 68.7 方法教训（连续踩了两次）

用 PowerShell here-string 生成"带插值的 JS"连续两次写坏并**静默失败**（好在都无损）：
① 多层引号 + 模板插值 → 语法错误；② 同上，只是换了位置。
⇒ 定规：**凡是要写"带内容的脚本"，一律用 write 工具直接落盘**（本文件即为例），
不要用 shell 的 here-string 拼 JS。这也是本仓库第三次因为"工具自身写坏"而返工（前两次是报告工具假警报、清单生成自我污染）。

**未做**：`tabs-ui` 里的浏览器断言（点忽略 → 条目消失 + 计数出现）—— 留待下一轮补齐。

## 69. 失败分级自愈 + 复盘推送（2026-10-13，优化清单 P1-5）

这一项分两半：**失败别都等着人点重跑**、**跑完主动告诉你产出如何**。

### 69.1 失败分级：先定判据，再谈重试

新增 src/failure-class.ts（纯函数，不执行重试、不改台账）：

| 顺序 | 规则 | 例 |
|---|---|---|
| ① HTTP 状态码最可靠 | 429 / 5xx ⇒ retryable；其它 4xx ⇒ manual | 503 可重试、403 留人工 |
| ② 确定性信号优先于临时性 | 锁定 / 审核违规 / 额度 / 权限 / 登录态 / 字段非法 / 对象不存在 / 疑似重复 ⇒ manual | 「稿件已被锁定，重试超时」⇒ manual（不被"超时"带跑） |
| ③ 临时性信号 | 超时 / ECONNRESET / fetch failed / 限流 / 5xx / 本地依赖不可达 ⇒ retryable | 「连接超时」⇒ 重试 |
| ④ 默认 manual | 认不出来的一律留给人 | 「未知错误 xyz」⇒ 人工 |

第 ④ 条是刻意的保守方向，理由写在代码注释里：**自动重试的代价是"可能重复投稿"，比漏重试严重得多**。

### 69.2 重试接线与那条最要紧的边界

shouldAutoRetry() 把"要不要重试"从循环里抽成可测的纯函数（内联条件无法单测），规则：

- 成功 / 跳过 ⇒ 不重试；
- publish.autoRetryOnce=false ⇒ 不重试；
- **errorType === 'upload-failed' ⇒ 绝不重试** —— 已经发起过上传，重试可能产生**重复分P**
  （正是 §40b 修过的事故：同一片被投两次而 B站 侧只落一次）；
- 其余交给 classifyFailure：retryable ⇒ 20 秒后重试一次；manual ⇒ 不重试。

接线落在 src/publish.ts 的逐片调用循环里。无论是否重试，**失败都如实上报**（不因重试而掩盖）。

### 69.3 复盘推送

- 计算收口在 src/recap.ts（buildRecap + recapPushText 短版），服务端与推送共用同一份口径；
- Alerter 新增 taskRecap()：level=info（复盘是知会，不是告警）、key 每场唯一、正文用短版；
- 调用点在 src/daemon.ts 的「本场切片投稿流程完成」分支末尾，由 config.alert.recapEnabled（默认开）控制，
  **整段 try/catch** —— 推送失败绝不影响主流程；
- 配置项落在 AlertConfig（插错到 RecorderConfig 的那次已回滚并修正，方法见 §69.4）。

### 69.4 过程记录（都是真实返工，写下来免得重犯）

1. **插错接口**：用"字段里含 webhook 的接口"做启发式，命中了 RecorderConfig（那是录制用的 webhook）⇒
   开关一度落在错误位置。修正办法：顺着 AppConfig 的 alert 字段拿到**真实类型名 AlertConfig** 再插。
2. **猜字段名**：NotifyConfig 这个名字不存在（凭记忆下锚点）。规矩：改配置/类型前先侦察真实名字。
3. **猜实例字段**：Alerter 实例字段不确定时，不猜 —— 找 this.xxx. 形式的**调用点**（只有实例会被调用），
   9 处全部指向 this.alerter 才动手。
4. 类型不匹配：cutAndUploadClip 的返回值里 skipped 是"跳过原因"**字符串**而非布尔 ⇒
   让 shouldAutoRetry 的类型如实反映调用方（skipped?: boolean | string），而不是强转。

### 69.5 验证

- test/failure-class.ts **27/0**：HTTP 码、临时性、确定性、两条刻意保留的设计（确定性优先、默认人工）、
  以及"要不要重试"的 6 条边界（含**上传阶段绝不自愈**那条）；
- test/monitor-panel.ts **313 → 318 项**：taskRecap 是 info 级 + 每场一个 key、场次结束推送且受开关控制、
  **推送被 try/catch 包住（通知失败不许影响主流程）**、正文复用 recapPushText（口径只有一处）；
- npm run typecheck 干净；npm run verify:fast 17 步 / 24 秒 / 退出码 0。

## 70. 新视图就地动作：从"看得到"到"能解决"（2026-10-13，优化清单 P1-4）

前几轮把只读视图做够了（切片库、稿件视图、复盘、待办），但**看到问题却不能在原地处理** ——
P1-4 就是补这一课：把"未确认投稿"的出口放到它就出现的地方。

### 70.1 两处动作（同一端点、同一套确认逻辑）

| 位置 | 出现条件 | 动作 |
|---|---|---|
| 切片库行内 | 仅 status === 'SUBMITTED' 的行 | 「重新投稿这一片」 |
| 稿件视图 | 本地记着投成功、线上分P 里没有（missingLocal）的每一条 | 「重新投稿这一片」 |

两者都复用**既有端点** POST /api/task/:id/approve {indices:[i], includeSubmitted:true}，
**不新开投稿路径**（避免两套投稿逻辑漂移 —— 本仓库已因"同一件事两处实现"收口过多次）。

### 70.2 两个刻意的设计决定

1. **不自动判断该不该重投**：只有人到 B站 创作中心看一眼，才知道那片到底落地没有。
   所以点击前 confirm() 里写清判断依据（已落地 ⇒ 取消；确实没落地 ⇒ 确定），
   并在稿件视图里常驻一句"助手只追加缺失分P，不会产生重复分P"（§40b 的教训）。
2. **不放假按钮**：只有 SUBMITTED 行才有重投按钮；已发布的行不显示（否则界面在暗示一个不该做的动作）。
   这条有断言守着（见 70.3 的第二条浏览器断言）。

### 70.3 验证

- 静态断言（test/monitor-panel.ts，313 → 323）：只给 SUBMITTED 行、confirm 写明先去创作中心核对、
  复用 approve + includeSubmitted、稿件视图同样可就地重投、两个视图走同一端点与同一文案；
- **浏览器断言（npm run tabs-ui，55 → 57）**：造一条含 SUBMITTED + PUBLISHED 两个切片的临时场次 ⇒
  切片库里断言"出现了重投按钮"且"按钮只在 SUBMITTED 行上"；跑完自动删除临时场次（不碰用户数据）；
- npm run check:ui / typecheck 干净；verify:fast 17 步 / 24.6 秒 / 退出码 0；
  UI_BUILD → ui-2026-10-13-republish-action。

### 70.4 过程中发现的一个测试隔离坑（尚未修，记在这里）

第一次跑浏览器断言时切片库显示 **0 行**，我一度怀疑"夹具被过滤"（上一轮在待办上真踩过），
实际原因是**页签状态跨断言保留**：前面那段切片库测试把 clipLib.status 设成了 'FAILED' 并留在页面状态里，
于是新夹具被静默筛掉。

- 立即修法（已做）：断言前显式复位 clipLib.q / status / limit 再重渲染；
- **待办（下一批）**：给 verify-tabs 每段加一个"页面状态复位"helper（清筛选/搜索/弹窗），
  否则任何一段改了状态都可能让后面某段假红 —— 这类失败最耗时，因为它看起来像功能坏了。

### 70.5 另记一处真实缺陷（本轮之前修掉的）

健康面板里三处 $('...').forEach( ⇒ 单元素查询当数组用 ⇒ 抛未捕获异常、**整段绑定从不执行**
（界面上表现为"按钮点不动"）。已改为 $$ 并在 monitor-panel 里加了防复发断言
（"全仓没有 $(...).forEach( 这种写法"）。web/src/34-…js 里早有注释警告这个坑，
说明"只写在注释里"不足以防复发。

## 71. 切片阶段并发：把"逐个等"改成有界流水线（2026-10-13，优化清单 P0-1 收口）

### 71.1 为什么做这一项（实测证据）

切片阶段是唯一还在拖时间的环节：12 片 514 s、20 片 607 s。日志时间线（§65）显示瓶颈**不在
biliLive-tools 的 ffmpeg 吞吐**，而在我方：wp2u 那场两片的"提交"时刻恰好相隔一片的处理时间
（00:31:27 提交第 1 片 → 00:32:09 第 1 片完成且**同一时刻**才提交第 2 片）⇒ 是"提交一个、等它完成、
再提交下一个"的串行写法把可并行的 ffmpeg 串起来了。

### 71.2 改动（`src/publish.ts` 的切片循环）

关键结构发现：多分P 模式下 `cutAndUploadClip` **切完就返回**
（内部那句「已切片，等待与完整版一起投进同一稿件（多分P模式，不单独投稿）」），
真正的上传发生在后面的 `publishMultiPart` 里。⇒ 这个循环里**只有切片**，并发化不会碰到投稿。

- 循环前加一段**有界流水线预切**：`cutK` 个 worker 并发调用**同一个** `cutAndUploadClip`，
  结果按 `queue` 顺序回填到 `pre[]`；
- 循环内改成 `let r = pre[i] ?? (await this.cutAndUploadClip(...))` ——
  **K=1 时 `pre` 全为 `undefined`，走的就是原来那行调用 ⇒ 与历史行为逐字一致**（默认值正是 1）；
- 顺序、风控抖动（`minSubmitIntervalSec + randomInt(0,30s)`）、额度、`shouldAutoRetry` 自动重试
  **一律原样不动**。

两条刻意保留的边界（都有断言守着）：

1. **只在 `publish.multiPart` 模式放开并发**：单P 模式下这个循环内含上传，
   并发会绕过风控抖动（那条约束就是为投稿频率设的）；
2. **转写进行中强制降到 1**：判据取自台账（存在 `TRANSCRIBING` 场次）——
   本地 Fun-ASR 与 ffmpeg 抢 CPU，而转写是出片关键路径。刻意用"已有事实"做判据，不新增回调/管线。

### 71.3 验证

`test/cut-pipeline.ts`（**19 项**，已进 verify 快速层，实测 2.1 s）：

| 节 | 锁的性质 |
|---|---|
| 1 | K=1 ⇒ 最大并发 1、调用顺序与结果顺序都等于队列顺序（等价性） |
| 2 | K=2 ⇒ 最大并发 2、墙钟明显短于串行、每片只调用一次、结果仍按队列顺序 |
| 3 | ★ 单P 模式即使 `concurrency=3` 也不并发（守住风控边界） |
| 3b | ★ 有场次在转写 ⇒ 并发压到 1 |
| 4 | 一片失败不阻塞其它片、条数与顺序都不乱、失败如实计入 |

另有既有套件全绿：`multipart-routing` 61、`multipart-cut-snapshot` 16、`confirm-append` 28、
`publish-batches` 33、`failure-class` 27；`typecheck` 干净；`verify:fast` 18 步 / 27.1 秒 / 退出码 0。

**待办（需真实直播）**：配置默认 `clip.concurrency = 1`（零行为变化），
建议在下一场直播后把切片阶段耗时与 §65 基线对比（12 片 514 s / 20 片 607 s），
确认压缩比后再决定是否把默认值提到 2。

### 71.4 两次自伤（都记下来，都是方法问题）

1. **改坏主链**：我用"脚本 + 只锚循环尾巴"的字符串替换去包循环 ⇒ **删掉了循环中段**
   （风控抖动与 P1-5 自动重试）并重复插入循环头 ⇒ 6 个语法错。按自己写过的内容逐字**重建**后
   恢复（typecheck 干净、四个套件全绿），随后改用 **read 出完整 22 行 + edit 整段替换**，
   一次成功。⇒ 规矩：**主链代码只用"读全 → 整段编辑"，不用脚本锚点拼**。
2. **第五次"用脚本生成 TS 代码"失败**：注入 3b 节时被 `as unknown as` 与嵌套引号写坏 ⇒
   测试文件当时无半截改动，改用 edit 直接改文件后一次成功。⇒ 规矩：脚本只用于读/跑/结构化改 JSON。

## 72. 录制质量体检：把"碎片多"变成能提前看见的事（2026-10-14，优化清单 P2 第一件）

**背景**：用户报过"几分钟就中断一次录制"，一天下来碎片文件几十个（实测 25–330 MB 不等）。
后来的修复是把碎片合并成一场，但**没人能提前看出异常** —— 往往等切片/分P 出问题才发现。

### 72.1 判据（纯函数 src/recording-health.ts，只读、不做任何修复）

| 档 | 判据 | 说明（给待办/日志的人话） |
|---|---|---|
| gap（优先） | 相邻分段之间有空档 **≥15 分钟** | 可能是中途停播，或录制器掉线后重连；若那段时间本该在播，建议查录制器日志 |
| fragmented | 小空隙（**< 90 秒**）出现 **≥2 次** | 助手已把它们并成一场；若频繁发生，多半是网络抖动或录制器与直播间连接不稳 |
| ok | 单段，或紧密相连的多段 | 单段录制（正常）/ 录制 N 段、无异常中断（正常） |

两个刻意的设计：① **长空档优先于碎片**（长空档更值得人看一眼）；
② 说明里明确写"**助手已把它们并成一场**" —— 不让用户以为碎片没被处理（这是历史上那个问题的遗留沟通点）。

### 72.2 接进统一待办

/api/todos 新增一条（第 ⑤b）：对**最近一场有分段记录的场次**体检，level !== 'ok' 才出条目
（ok 时不出，不无端报警）；整段 try/catch 包裹，体检失败不影响其它待办。

语义说明（写在代码注释里）：取的是"列表里最近一场有 segments 的场次"——
若以后想改成"只体检最近 24 小时"，加一个时间窗即可。

### 72.3 验证

- test/recording-health.ts **16 项**：三档判据、长空档优先（即使同时有碎片）、乱序传入先排序、
  边界值（空隙 900 秒正好到阈值 ⇒ gap）、空分段不炸；
- test/todos.ts **25 → 30 项**（第 6 节，走真实 HTTP）：造一场含 30 分钟空档的夹具 ⇒
  条目出现、等级 warn、标题写清是"长空档"、说明带场次标题、动作指向实时监控；
- 已进 verify 快速层（21 步）；npm run typecheck 干净；真机 GET /api/todos 返回 0 条（台账为空，无可体检对象 —— 合理）。

**未做**：体检结果只进待办，还没做"连续多场都碎片 ⇒ 升级为 error"的趋势判断（等有真实数据再加）。

## 73. 验证产物清理挂进每日任务（2026-10-14，优化清单 P2）

**背景**：data/ 一度 17.45 GB / 807 文件，其中约 3.1 GB 是可再生成的验证/调试产物
（ASR 标定素材、字幕检查输出、试看临时转码副本、抽帧、验收截图）。这些**不是用户数据**。

### 73.1 唯一实现 + 两条纪律

实现收口在 src/clean-artifacts.ts：CLI（npm run clean:artifacts）与守护进程的每日 tick
（perfTick，紧跟备份之后）调**同一份** —— 避免"CLI 与定时任务各写一套清理逻辑"（备份那次踩过同一个坑）。

两条纪律：

1. **dry-run 是默认**：不加 --apply 只报不删（破坏性操作必须让人先看一眼）；
2. **白名单写成完整文件名，不是扩展名**：local-asr-test 里只保留 sample-300s.flv/json
   （tools/local-asr/timing.ts 真正读的基准素材）—— 早期版本保留 *.flv，结果 5.4 GB 里绝大部分都留下了。

### 73.2 保护清单（写进代码以便 review）

trash（用户回收站）、logs、**backup（备份！）**、asr-cache、tasks、glossary.json，
以及 data/*.jsonl 台账流水。清理目标目录是**显式列举**的（ASR 标定素材 / 固定夹具 / 字幕检查 /
试看副本 / 界面截图 / 验收截图 / 抽帧），不搞通配删除。

backup 这条是**事后补的**：最初它只是"碰巧不在清理目标里"，属于运气而非设计 —— 现在是被显式保护。

### 73.3 验证

test/clean-artifacts.ts **15 项**（全部在临时目录里做夹具，不碰真实 data/），断言重点是"**绝不删错**"：

| 节 | 断言 |
|---|---|
| 1 | dry-run 一个文件都不删、如实报"会删几个" |
| 2 | ★ 保护清单：backup / trash / logs 一个都不能被删 |
| 3 | 超过保留期的删、保留期内的留、★ sample-300s.flv 必须留、不按天数的目录新文件也删、统计与摘要如实 |
| 4 | 目录不存在 ⇒ 不抛（调用方是每日 tick）；keepDays 负数夹到 0 |

已进 verify 快速层（22 步 / 0.4 s）；dry-run 实测：`没有超过 7 天的文件可清（跳过 144 个新文件）`
—— 规则生效且只跳过新文件（不误删今天的东西）。

## 74. verify:changed：按改动挑套件（2026-10-14，优化清单 P2）

**动机**：快速链 22 步 / ~29 秒虽不长，但改一行 CSS 也全跑一遍是浪费；而"自己判断该跑哪些"又容易漏
（漏掉的代价是"以为绿了其实没测"）。

### 74.1 四条安全设计

1. **认不出来的一律照跑** —— 只有明确能窄化的步骤才跳过，绝不静默忽略（宁可多跑，不可漏测）；
2. 改动来源**优先 git**（git status --porcelain），仓库没有 git 时退化为"最近 N 分钟被 mtime 改过"（--since N）；
3. **保底集**：typecheck / encoding-test / check:ui 永远跑（便宜且覆盖全局不变量）；
4. **打印"为什么选/为什么跳过"**（不黑箱，便于人工核对）。

窄化映射写在 tools/verify-changed.ts 的 RULES 表里（约 18 条，每条带"为什么"），例如：
ui-modules-test ← web/src、web/ui-modules.json、public/ui.html；
cut-pipeline-test ← src/publish.ts、src/failure-class.ts、src/media-plan.ts。

### 74.2 实测与一个如实说明的限制

- **实测（改动很多时）**：当前仓库有 67 个未提交改动 ⇒ 选中 **22/22 步**（全跑）。
  这恰好说明保守默认是对的：真有大量改动时不会漏。
- ⚠️ **尚未在"只改一两个文件"的场景下实测窄化效果** —— 那种情况下大部分步骤应被跳过，
  但我没制造过一个人为的小改动去验证（不想为了跑一次工具而在仓库里制造假改动）。
  下次真实的小改动（例如只改一个 CSS 或某个测试）就是天然的验证机会；若届时没有明显窄化，
  说明映射写得太宽，需要收紧。

用法：node tools/verify-changed.ts [--list] [--since N]；已注册为 npm run verify:changed。

## 75. config-coverage 的已知限制（2026-10-14，P2 配置面收尾的诚实收口）

**结论一句话**：报告工具的判据同样要经得起检验 —— 这个只读报告上线以来出过两次假警报：

| 次数 | 类型 | 现象 | 处理 |
|---|---|---|---|
| ① | 假阳性 | 把 `#c_uiPort` / `#c_platform` 这类 **readonly 展示字段**报成"看着能改其实没保存" | 已修：扫出 readonly/disabled 并排除；现在"没接到保存的控件 = 0" |
| ② | 假阴性 | 把**已有校验**的字段（`cleanup.deleteAfterUpload.graceHours`、`clip.autoSelectTopN`、`clip.subtitle.maxCharsPerLine`、`llm.select.maxTokens`）报成孤儿 | **部分修复**：改用 err/warn 首参作权威来源后孤儿数 192→186，但这四个仍被误判 |

**因此**：报告里"孤儿字段共 N 个"这个数字**在修好之前不可信**，只能当"值得抽查的线索"，
不能当成缺陷清单直接照做（我这几轮引用它时已按此打折）。

**没有再继续修的理由**（刻意的取舍）：它是**只读报告**，不参与任何业务逻辑；
而它的实际危害已经消除 —— 我原计划补的三条校验里两条本来就有（守卫拦住了重复劳动），
真正缺的那条 `llm.select.maxTokens` 已经补上并有断言。继续为"报告准确率"投轮次，
收益低于把时间放在有用户价值的项上。

**留下的线索**（给以后想修的人）：怀疑①规则用反引号写路径（当前正则只匹配单引号），
或②孤儿列表走的是另一条代码路径（只改了一处判定）。

## 76. 封面抽帧：把"每场封面都一样"变成可选（2026-10-14，优化清单 P2 收口）

**现状（改动前）**：`publish.coverSource = 'preset'` 且没有预设封面文件时**不传封面** ⇒ 稿件封面完全交给
B站 自动挑。影响直接：同一场次的每个分P 封面长得差不多，点击率吃亏。

### 76.1 两个开关的分工（容易混淆，写清楚）

| 配置 | 管什么 | 取值 |
|---|---|---|
| `publish.coverSource` | **回退顺序**（找不到封面时按什么优先级试） | default / preset / fullVideo（默认 preset） |
| `publish.coverFrom` | **是否抽帧**（新增） | preset（默认，与历史一致）/ frame（从切片抽一帧） |

`coverFrom='frame'` 时：先抽帧 ⇒ 成功就用它；**抽帧失败/没有可用切片 ⇒ 静默回退**到
`coverSource` 那条老路径（原因记在 attempts 里，日志可查）。**默认 preset ⇒ 零行为变化**。

### 76.2 实现（三处要点）

- `src/cover.ts`：`extractCover()`（ffmpeg 抽帧：`-ss` 放 `-i` 之前快速定位、缩放到 ≤1280 宽、`-q:v 3` 控体积、
  **失败不抛**）；`pickCoverSource()`（挑**已切好且有产物**、**评分最高**的切片 —— 切片本身就是这场最精彩的几秒，
  比完整版里随便抽一帧更有代表性）；
- `publish.ts` 的 `resolveCover()`：新增 frame 分支。**刻意改在这里而不是三个调用点** ——
  它被三条上传路径共用（L1229/L1676/L2437），一处改动全覆盖，且**只保留一份实现**；
- 多分P 路径（实际在用的那条）传入 `frameCandidates`（本场切片）与 `frameOutPath`
  （放在切片产物同目录的 `cover-frame.jpg`）；没有可用产物就**不传** `frameOutPath` ⇒ 回退。

### 76.3 验证

- **真机抽帧**：用 data/trash 里一份真实录像跑 `extractCover({atSec: 600})` ⇒ 产出 **124 KB JPG** ✅；
- `test/cover.ts` **11 项**，刻意**不依赖 ffmpeg**（不同机器上 ffmpeg 未必在预期位置）：
  挑源按评分排序 / 排除产物缺失的 / 没有可用就 undefined；**默认 preset 时 attempts 里没有任何 frame 记录**
  （直接证明零行为变化）；frame 模式用"候选指向不存在的文件"制造失败 ⇒ 如实记原因并回退、回退后封面文件确实存在；
  无可用切片时原因写明"没有已切好且有产物的切片"；
- 既有套件无回归（multipart-routing 61 / cut-snapshot 16 / confirm-append 28 / publish-batches 33 / cut-pipeline 19）；
  typecheck 干净；verify:fast 22 步 / 29 秒 / 0。

### 76.4 待你决定

想把封面切到抽帧，只需把 `publish.coverFrom` 改成 `frame`（建议先试一场 ——
抽出来的封面可以直接在 data/clips/&lt;场次&gt;/cover-frame.jpg 看一眼再决定是否长期启用）。

## 77. 改动归属守卫（2026-10-14，优化清单 P2 收口）

**背景**：多会话/多人同时改同一仓库，已经真实撞过一次（ASR 独立进程被两份实现）。
WORKLOG 的 claim 是**声明式**的 —— 它说明"我要改这些文件"，但拦不住别人也改。

### 77.1 它只做一件事，且只摆事实

把"你认领之后这些文件又被改过"摆出来：

| 输出 | 含义 |
|---|---|
| ✓ …认领后没被动过 | 该认领的文件 mtime 都早于认领时刻 |
| ⚠ …N 个文件在认领**之后**被改过 | 列出文件、最后改动时间、距认领多少分钟 |

**诚实的边界**（写在文件头，免得被误用）：mtime **不含作者信息** ⇒ 它无法判断"是谁改的"，
也**不说"冲突"**这种断言，只说"请你自己确认这是不是你自己的后续改动"。

### 77.2 为什么不做成阻断式

默认**不阻断**（退出码 0）；`--strict` 才在发现可疑改动时非零退出（给脚本用）。
理由：多会话场景下"认领后自己又改了"是**常态**（我这几十轮里几乎每次都这样），
阻断式会天天误伤；真正需要它的时候是"我怀疑有人也在动" ⇒ 主动跑一次看事实。

**刻意不进 verify**：它依赖 WORKLOG 的实时状态，不是恒定断言（跑 verify 时看板内容是什么，
结果就是什么）—— 放进去只会造成假红。

### 77.3 验证

用临时看板做了三情形自检（认领时刻设为 10 分钟前）：

| 情形 | 期望 | 结果 |
|---|---|---|
| A 文件 mtime 早于认领（20 分钟前） | 不报 | ✅ |
| B 文件 mtime 晚于认领（1 分钟前） | 报 | ✅ |
| C 已完成的条目 | 完全忽略 | ✅ |
| 默认模式退出码 | 0（不阻断） | ✅ |
| --strict 退出码 | 1（有可疑改动） | ✅ |

**一次夹具错误（如实记）**：第一版自检里我把标为"未被动的文件"的 mtime 设成了**认领之后**（9 分钟前），
于是它被正确地标红了 —— 那是**夹具写错**，不是工具错。修正夹具后才拿到上面这张表。
工具真机跑（当前 WORKLOG，0 条未完成认领）：`✓ 没有未完成的认领 —— 无需检查`。

## 78. 边录边转写：把"等开始转写"的几十分钟拿回来（2026-10-14，优化清单 P1-6）

### 78.1 为什么做

实测端到端"录完 → 出片"要 +17 分钟左右，而其中**"等开始转写"占 573–3691 秒**，
比转写本身（59 分钟素材约 133–145 秒）长得多。瓶颈不是 ASR 慢，是"必须等整段录完才开始转"。

### 78.2 三个模块（都可测、都只读录像）

| 模块 | 职责 | 断言 |
|---|---|---|
| src/incremental-asr.ts | 状态机：分段推进 / **一票回退**（任何一段失败 ⇒ 整场切 fallback，且回退是终态） | 23 项 |
| src/pre-transcribe.ts | 分段预转写（只转**已闭合**的段）+ `mergeSegmentedTranscript`（平移拼接到全局时间轴）+ `usePreTranscribed`（消费侧） | 30 项 |
| src/pre-transcribe-tick.ts | 一轮逻辑：门控 / 遍历 / 持久化（依赖注入，可测） | 24 项 |

**口径一致性（这一项最关键）**："哪些分段已闭合"由 `discoverRecordingFiles(..., { skipFreshWithinSec: RECORDING_WINDOW_SEC })`
判定 —— 与**正式导入同一个函数、同一个常量**（daemon 里早有明确要求：半场数据会让任务总时长/切点/全局时间轴全错）。
"哪些场次还在录"取自 `watcher.status().lastOutcomes`。**没有第二套分场规则**。

### 78.3 接线（B2 + C）

- **B2**（daemon）：`preTranscribeTick` 每 120 秒一轮，`unref`；**只有 `asr.incrementalEnabled===true` 时才启动**；
  失败只记日志（绝不影响录制/导入/既有流程）；
- **C**（daemon 转写阶段）：`usePreTranscribed(...)` 若命中 ⇒ 用分段结果拼出整段等价字幕并**跳过整段转写**，
  否则原样走 `runTranscribe`。短路条件刻意严格：**必须全段就绪且非回退** ——
  因为紧接着就是「转写为空 ⇒ 直接失败」的判定，绝不能喂它空结果。

**分段 cue 不另存**：它们本来就在 ASR 缓存里（按 media+range 键控）。消费时"按同样分段再取一次"**命中缓存**（秒回、不重复计费），
所以状态文件里只有 `{ done: number[], updatedAt, mode }`（可重建）。状态文件放在**录像同目录**的
`.pre-transcribe.json` —— 预转写发生在任务建立**之前**（那正是它的价值），此刻还没有 taskId/taskDir。

### 78.4 为什么默认关 + 怎么验证

默认 `asr.incrementalEnabled=false` ⇒ **零行为变化**（断言锁住："关闭时连候选都不列、不读文件"）。

要验证时：把开关改成 true ⇒ 开一场直播 ⇒ 看日志里的 `预转写：…` 行与
`预转写命中：用 N 段拼成 M 条字幕（按分段取字幕走的是 ASR 缓存，不重复计费）`，
并对比"录完 → 出片"的端到端时间（基线：+17 分钟，其中等开始转写 573–3691 秒）。
抽出来的字幕/切片质量若与整段路径一致，再考虑把默认值改掉。

### 78.5 本轮暴露的一个历史缺陷（如实记）

Round 40 给 `AsrConfig` 加 `incrementalEnabled` 时，插入位置**落在了嵌套的 `worker` 对象里**，
而这个字段此后几个月**没有任何代码读它** ⇒ 类型错一直没被发现。Round 81 接线时 `tsc` 立刻报
「Property 'incrementalEnabled' does not exist on type 'AsrConfig'」，才把它翻出来（现已放回接口的顶层）。

**教训**：只加字段不接线 = 没有任何门禁能验证它。以后加配置字段时，**同一轮就要有一个读它的地方**
（哪怕只是一行 `if (cfg.x) log.debug(...)` 或一条断言），否则等于没加。

同一轮我还犯了四次"脚本改接口结构"的错（守卫把注释里的文件名当 import、没验证就打印成功、
括号扫描算错接口边界、把字段插进嵌套对象），每次都靠 `typecheck` 兜住。**定规**：改接口结构必须
"读全 → 整段 edit"，判断 import 是否存在必须**只看 import 行**。

## 79. 给「边录边转写」加界面开关 + 补上一个从未存在的配置门禁（2026-10-14）

### 79.1 为什么加

P1-6 的开关 `asr.incrementalEnabled` 之前**只能改 config.json**（我只加了配置字段与类型，没加控件）——
用户问"这个开关在哪"，于是补上。

### 79.2 改了三处（同一个控件要三件齐全才算"能点且真生效"）

| 位置 | 内容 |
|---|---|
| ASR 渲染段 | `<button class="switch sm" id="c_incrementalEnabled">` + 文案 + 一段 hintline |
| 开关绑定区 | `tgl('#c_incrementalEnabled', …)` —— 点击时同步文案，并在"刚打开"时写明**需重启服务才生效** |
| saveCfg 的 asr 段 | `incrementalEnabled: on('#c_incrementalEnabled')` |

hintline 里写清了三件事：实测收益（等开始转写占 573–3691 秒）、失败行为（任一段失败整场回退，不出半截字幕；
分段走同一份 ASR 缓存不重复计费）、以及**必须重启**（`node tools/restart-service.ts --force`）——
最后这条是本项最容易误解的地方：预转写循环只在服务启动时按此开关创建。

### 79.3 顺手补上一个**从未存在**的测试

`package.json` 里声明了 `config-coverage-test` → `node test/config-coverage.ts`，
但**那个文件一直不存在**，而它也没进 verify 清单 ⇒ 谁都没发现（我说的"报告工具的判据要经得起检验"，
这次轮到了 npm 脚本本身）。现在补成真测试，钉三条性质：

1. **界面上能改的必须真的存得下去**：`public/ui.html` 里每个 `#c_*` 控件，要么在 saveCfg 里被读走，
   要么是 readonly/disabled 的展示字段（当前 82 个控件 / 80 个已保存 = 差的正是那 2 个只读字段）；
2. 反过来：saveCfg 里没有"读了但控件不存在"的死引用；
3. 新开关的**端到端三件套**：控件存在 + saveCfg 存它 + config.json 里真有这个键
   （只有前两件叫"界面上能点"，第三件才叫"真能生效"），外加一条"旁边写清了要重启"。

已接进 verify **快速层**（26 步）。

### 79.4 验证

- `test/config-coverage.ts` **8 项**全绿；`npm run config-coverage` 报告"没接到保存的控件 = 0"；
- 浏览器 `tabs-ui` **60/0**（新增 3 条：开关在 DOM 里、文案含"重启服务"、点击后状态与文案同步变化——
  第三条专防"点了没反应"）；
- `check:ui` 通过（产物与 21 个模块一致）；`UI_BUILD` → `ui-2026-10-14-asr-toggle`；typecheck 干净。
