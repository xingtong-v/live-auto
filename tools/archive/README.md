# tools/archive —— 历史排查脚本（归档，不再维护）

这些脚本是**过去排查具体事故时写的一次性工具**：它们记录了「当时是怎么查的」——
例如 `find-*` 在 biliLive-tools 的 asar 里定位实现、`diagnose-*` 复现某个故障、`probe*` 探接口返回。
它们**不参与运行、不在测试链里、也无人引用**；2026-10-14 从 `tools/` 归档到这里，
只是为了让 `tools/` 顶层一眼看清哪些工具是**在用的**。

**要用它们时**：`node tools/archive/<名字>`（里面的相对 import 已改成 `../../src/`，路径仍然有效）。
**不要在这里加新东西** —— 新的排查脚本放 `tools/`，用完再决定归档或删除。

| 文件 | 大小 | 当初是查什么的（取自文件头注释） |
| --- | --- | --- |
| `analyze-run.ts` | 10.9 KB | 汇总一次任务的 |
| `anchor-window-probe.ts` | 1.7 KB | 验证能量锚点选的位置对不对：把出问题那个窗口（351.9→392.4s）的响度剖面打出来， |
| `append-one-probe.ts` | 3.1 KB | 对照实验：单独追加 |
| `asr-cache-probe.mjs` | 1.8 KB | 排查（第六步）：云 ASR 的 |
| `asr-call-history.ts` | 2.4 KB | 对比 biliLive-tools 日志里 |
| `asr-failure-diagnose.ts` | 3.0 KB | 诊断：为什么 ASR 大面积缺失。 |
| `asr-offset-verify.ts` | 6.5 KB | 验证 `/ai/subtitle` 的 |
| `asr-timestamp-compare.ts` | 6.8 KB | 同一段音频， |
| `audit-appended-parts.ts` | 4.6 KB | 核实 43 个分P 里每一批的来源：每个切片标题 |
| `autoflow-realfile.ts` | 5.0 KB | 真实录播文件 |
| `av-sync-experiment.ts` | 6.1 KB | 受控实验：找出「切片后音画错位」到底是哪一步造成的，以及哪种参数组合能修好。 |
| `blt-config-probe.ts` | 3.2 KB | 侦察 biliLive-tools 的配置结构：找它自己的录制目录与房间列表。 |
| `blt-config-set.ts` | 4.8 KB | 精确修改 biliLive-tools 的一个配置字段（GET /config → 改一个键 → POST /config）。 |
| `blt-db-inspect.ts` | 2.8 KB | 查看 biliLive-tools 的 sqlite 库里有什么表 —— 用于找"投稿预设"（含"仅自己可见"开关）。 |
| `blt-file-set.ts` | 2.7 KB | 直接修 `appConfig.json` 的某个字段（当 `/config/set` 与 `POST /config` 都被忽略时用）。 |
| `blt-preset-probe.ts` | 3.6 KB | 查证：biliLive-tools 的「压制 / 视频处理」预设到底能做哪些事。 |
| `check-0922-material.ts` | 4.7 KB | 检查 2026-09-22 那场直播的本地素材完整性 —— 决定「能否用它验证续传投稿」。 |
| `check-2plusn-chain.ts` | 7.4 KB | 「一场直播 = 1 个稿件 / 2+n 个分P」链路的 |
| `check-clip-snapshot.ts` | 4.2 KB | 验证一个会让「多分P 投稿」静默投不出切片的假设： |
| `check-immediate.ts` | 3.5 KB | 直接验证 `buildBiliupConfig` 产出的投稿配置里到底有没有 `dtime`。 |
| `check-multipart-reality.ts` | 6.1 KB | 回答一个具体问题： |
| `check-only-self.ts` | 4.3 KB | 检查"仅自己可见"在两个软件里各自由谁控制 —— 上传前必须确认。 |
| `check-parts.ts` | 3.2 KB | 按 bvid 直接体检稿件的分P（2026-10-11，优化第二批 ① 的补齐）。 |
| `check-segment-readiness.ts` | 6.6 KB | 分段工作流的就绪检查（只读，不调用付费接口）。 |
| `clip-subtitle-coverage-probe.mjs` | 3.9 KB | 排查（收尾）：把问题量化到 |
| `confirm-segment.ts` | 8.2 KB | 再次确认「分段时间」——三路交叉验证，不靠单一来源。 |
| `diagnose-activate.ts` | 4.3 KB | 诊断：服务里那段"激活资源管理器窗口"的 PowerShell 脚本为什么没生效。 |
| `diagnose-append-failure.ts` | 2.7 KB | 诊断：重跑声称"已续传 14 个分P"，但 B站 侧分P 数没变（仍 23）。 |
| `diagnose-multipart-empty.ts` | 5.0 KB | 诊断「多分P 投稿为什么说没有任何可投稿的文件」。 |
| `diagnose-reveal.ts` | 6.3 KB | 诊断"打开文件管理器"到底有没有真的把窗口带到用户面前。 |
| `dump-archive-fields.ts` | 2.1 KB | Dump 本场稿件的 |
| `energy-anchor-verify.ts` | 3.8 KB | 验证「能量锚点」在 |
| `extract-blt-source.ts` | 1.4 KB | 从 biliLive-tools 的 app.asar（Electron 打包）里提取关键实现的上下文， |
| `find-autopartmerge.ts` | 2.4 KB | 定位 biliLive-tools 的 `autoPartMerge` / `partMergeMinute` 实际逻辑： |
| `find-blt-bili-router.ts` | 2.6 KB | 在 biliLive-tools 的 asar 里找 `/bili` 路由组（`new Router({ prefix: "/bili" })`） |
| `find-blt-upload-handler.ts` | 2.0 KB | 在 biliLive-tools 的 asar 里定位 |
| `find-live-lifecycle.ts` | 2.2 KB | 查 `Live` 何时被 |
| `find-mergepart-consumer.ts` | 2.1 KB | 找 `partMergeMinute` 的 |
| `find-minsize.ts` | 2.1 KB | 找 `minSize`（最小处理体积，配置 20MB）在流程中的 |
| `find-same-media-order.ts` | 1.7 KB | 精确提取 `SAME_MEDIA_UPLOAD_ORDER` 的 |
| `find-segment-def.ts` | 2.6 KB | 精确定位 biliLive-tools 录制器 `segment` 的 |
| `find-segment-unit.ts` | 2.4 KB | 确认 biliLive-tools 的 `recorders[].segment` |
| `find-validatefilesize.ts` | 1.8 KB | 找 `validateFileSize` 的调用点 —— 确认「小于 minSize 的碎片」在流程中的位置。 |
| `focus-window.ts` | 5.0 KB | 把标题匹配的窗口提到前台（用于验证/修正"打开文件管理器后窗口被浏览器挡住"）。 |
| `force-append-new.ts` | 5.2 KB | 独立验证：那 5 个"没进去"的切片 |
| `form-a-detail.ts` | 3.6 KB | 补充核对：形态A 的"条数变少"到底是 |
| `form-a-improvement.ts` | 9.6 KB | 形态 A（只对要投出去的切片窗口用本地重识别做字幕） |
| `history-file-check.ts` | 4.1 KB | 核查：为什么「别的主播的录播」没出现在清单里。 |
| `hybrid-asr-analysis.mjs` | 6.2 KB | 分析用（不改产品代码）： |
| `inject-todo-browser-check.mjs` | 6.2 KB | 把"待办闭环"的浏览器断言注入 tools/verify-tabs.ts（2026-10-13，P0-3 最后一块）。 |
| `list-parts.ts` | 1.9 KB | 打印一个稿件的 |
| `list-windows.ts` | 3.4 KB | 列出当前所有 |
| `live-room-finder.ts` | 5.4 KB | 从 biliLive-tools 的 `app.db` 里取出 B站 登录态，用于查"当前正在直播的房间"。 |
| `liveid-probe.ts` | 3.1 KB | 探查：biliLive-tools 录制历史里，同一场直播的多个分段是否共享 live_id。 |
| `llc-asar.mjs` | 2.9 KB | 从 biliLive-tools 的 app.asar 里按路径关键字导出源文件，用于 |
| `llc-db-probe.mjs` | 2.5 KB | 只读探查 biliLive-tools 的 SQLite（app.db），回答两个问题： |
| `llt-asr-probe.mjs` | 1.7 KB | 打印 biliLive-tools 侧"用哪个 ASR"（云端还是本地、哪个模型）。 |
| `llt-cut-probe.ts` | 2.0 KB | 排查：切片任务的 ffmpeg 参数到底是什么（字幕对不上的关键就在 `-ss/-to/-copyts/ass`）。 |
| `nickname-probe.ts` | 10.5 KB | 昵称候选查重（只读、无凭据、一次性工具， |
| `pick-trial-source.ts` | 2.6 KB | 挑一个「便宜又完整」的试跑素材：有同名弹幕、非烧弹幕版、体积适中。 |
| `pipeline-trace.ts` | 8.4 KB | 链路核对：把「当前这台机器上、当前这份代码里」的实际链路打印出来。 |
| `probe-blt-fullvideo.ts` | 3.8 KB | 核实「biliLive-tools 先投完整版+纯享版，切片助手追同一稿件」这条链路的前置事实： |
| `probe-blt-upload.ts` | 2.6 KB | 查 biliLive-tools 的上传/压制相关配置： |
| `probe-blt-webhook-chain.ts` | 4.3 KB | 确认 biliLive-tools 的 webhook 自动处理链是否真的会「压制弹幕 + 自动上传」。 |
| `probe-multipart-sources.ts` | 4.7 KB | 为「2+n 分P」的 P1/P2 生成方案做前置核实： |
| `probe-system-player.ts` | 6.3 KB | 系统默认播放器 |
| `probe-upload-aid.ts` | 3.4 KB | 探测 biliLive-tools `POST /bili/upload` 是否支持「续传到已有稿件」。 |
| `publish-history-shape.ts` | 3.6 KB | 统计历史投稿里 |
| `recorder-setup.ts` | 14.8 KB | 把用户指定的直播间加进 biliLive-tools 的录制列表，并启动录制。 |
| `run-quota-off-trial.ts` | 2.1 KB | 验证「关闭每日额度」：把 09-22 那场从 CLIPPED 阶段重跑，看剩下的 5 个切片能否补投。 |
| `run-resume-trial.ts` | 2.9 KB | 验证「续传投稿」：导入 09-22 那场的一个片段，切片后 |
| `run-trial.ts` | 1.7 KB | 真实试跑：把一场历史录播导入，跑完整链路（转写 → 分析 → 切片 → 投稿）。 |
| `run-trial2.ts` | 2.1 KB | 验证「立即发布」修复：小片段试跑，确认稿件 |
| `scan-survey.ts` | 4.5 KB | 侦察：录播到底散落在哪些目录。 |
| `simulate-partmerge-real.ts` | 4.8 KB | 修正版分场模拟：用 |
| `simulate-partmerge.ts` | 4.5 KB | 真实录制文件 |
| `speech-run-probe.mjs` | 4.5 KB | 排查（第五步）：那些"离谱 ASR 窗口"里， |
| `subtitle-diagnose.ts` | 6.8 KB | 字幕诊断：拿 |
| `subtitle-issue-locate.ts` | 6.5 KB | 字幕问题定位：找出「字幕挂太久」与「折行断在词中间」的具体数据。 |
| `subtitle-offset-probe.mjs` | 3.8 KB | 排查（第二步）：烧进视频的字幕，和转写的时间轴到底差多少？ |
| `task-detail.ts` | 1.9 KB | 精确查询单个 biliLive-tools 任务的状态与详情（诊断续传"报了成功但 B站 没变"）。 |
| `task-doctor.ts` | 3.7 KB | 诊断：列出所有任务及其真实状态，并检查是否有卡住的运行态。 |
| `task-source-check.ts` | 3.9 KB | 查证：某个任务的 source 元数据是否完整（尤其 totalDuration 为什么是 NaN/null）。 |
| `test-alert.ts` | 1.6 KB | 实测 Server 酱告警通道：走项目自己的 POST /api/test {target:'alert'}。 |
| `transcript-health-probe.mjs` | 3.5 KB | 排查（第四步）：转写自己的时间轴健康吗？ |
| `trial-preflight.ts` | 3.3 KB | 对候选试跑素材做只读预检：真实时长、转写窗口数、预估费用、弹幕条数。 |
| `trigger-watch-scan.ts` | 2.2 KB | 触发一次目录扫描（`/api/watch/scan`）并打印结论 —— 用来验证"新素材会不会被自动导入"。 |
| `verify-0922-archives.ts` | 3.9 KB | 核实：biliLive-tools 在 2026-09-22 那场直播，到底往 B站 投了 |
| `verify-append-result.ts` | 3.0 KB | 核实续传是否真的追加成功：向 B站 查目标稿件的 |
| `verify-archive-parts.ts` | 4.7 KB | B站 公开接口 |
| `verify-partmerge-75.ts` | 5.8 KB | 确认 `partMergeMinute` 改成 75 后是否真的生效，并用你的真实录制数据复算分场结果。 |
| `verify-prompt-iteration.ts` | 3.3 KB | 提示词迭代验证：用 |
| `verify-publish-mode.ts` | 3.9 KB | 核实稿件在 B站 侧的 |
| `watch-path-clarify.ts` | 4.8 KB | 澄清：biliLive-tools 的录制落盘目录到底是不是 watch 监控的那个目录。 |
| `watch-scan-probe.ts` | 4.1 KB | 探查：`import.watch.dirs` 到底有没有参与扫盘。 |
| `watch-task.ts` | 4.6 KB | 盯着一个任务跑完：轮询 /api/task/:id，把阶段时间线、切片数、状态变化打出来。 |

> 判定口径：没有被 package.json / README / 实现报告 / verify 清单 / src / tools/local-asr 提到。
> 如果你手工敲过其中某个脚本（命令行用法检索不到），把它挪回 `tools/` 即可。
