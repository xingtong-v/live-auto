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









