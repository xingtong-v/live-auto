# 工作看板（多会话协作）

> 同一个仓库上可能同时有多个会话/人在改代码。**开工前占位、改完销账**，避免两份实现撞车
> （2026-10-12 真实发生过：ASR 独立进程被两个会话各写了一份）。
>
> 用法（都在仓库根跑）：
>
> - 占位：`npm run worklog -- claim "任务一句话" --files src/a.ts,src/b.ts`
> - 销账：`npm run worklog -- done "任务一句话"`
> - 查看：`npm run worklog -- list`
> - 查冲突：`npm run worklog -- check src/a.ts`（被未完成条目占用则非零退出）
>
> 条目格式（机器可解析，别手改格式）：
> `- [ ] 2026-10-12T01:23Z | 会话 | 任务 | 文件：a.ts, b.ts`


- [x] 2026-10-11T04:02:03Z | session- | 优化第三批：配置面检查/模块归位/data 卫生 | 文件：tools/check-config-coverage.ts, web/src/41-切片库与稿件视图-跨场次检索-按-bvid-体检稿件.js

- [x] 2026-10-11T04:02:04Z | session- | ASR 独立进程（验收复核，不重复实现） | 文件：src/asr-worker.ts, src/asr-worker-client.ts

- [x] 2026-10-11T06:32:47Z | session:9aa24b6c-aef | 设置面板：为 asr.incrementalEnabled 加界面开关（含重启提示） web/src/42-设置弹窗.js test/config-coverage.ts tools/verify-tabs.ts | 文件：

- [x] 2026-10-11T07:28:48Z | session:9aa24b6c-aef | 归档 96 个零引用工具 + 设置面板实测标注 tools/archive/README.md web/src/42-设置弹窗.js test/config-coverage.ts | 文件：

- [x] 2026-10-11T07:50:55Z | session:9aa24b6c-aef | 浏览器验收脚本去重：抽共享件 tools/ui-shared.ts（2/9 已转） tools/ui-shared.ts tools/verify-health-ui.ts tools/verify-multiselect-ui.ts | 文件：

- [x] 2026-10-11T08:02:02Z | session:9aa24b6c-aef | 共享件收口：机会式采用 + 防新增副本闸门 + 归档 ui-diag tools/ui-shared.ts test/ui-shared-usage.ts tools/archive/README.md | 文件：

- [x] 2026-10-11T09:40:35Z | session:9aa24b6c-aef | 代码层清理：删 5 个遗留符号（86 行）+ 死代码/静默异常分级报告 src/analyze.ts src/daemon.ts src/danmaku.ts src/ledger.ts docs/implementation-report.md | 文件：

- [x] 2026-10-12T16:09:33Z | session:9aa24b6c-aef | 自动投稿语义澄清：勾选看门槛、投稿看数量上限 src/analyze.ts src/daemon.ts src/config.ts test/auto-publish-split.ts test/clip-boundary.ts | 文件：

- [x] 2026-10-13T11:29:40Z | session:9aa24b6c-aef | 本地 ASR 精度接线（llm_dtype）+ 修两个真 bug（代理项致整次失败、参数传错位置被静默忽略） src/asr.ts src/config.ts tools/local-asr/transcribe-funasr.py tools/local-asr/ab-llm-dtype.mjs test/local-funasr-provider.ts | 文件：

- [x] 2026-10-13T11:54:38Z | session:9aa24b6c-aef | bf16 开关上线（配置已打开）+ 设置面板一键切换 + 覆盖率断言 web/src/42-设置弹窗.js test/config-coverage.ts tools/verify-bf16-switch.ts tools/ui-shared.ts | 文件：

- [x] 2026-10-13T14:53:32Z | session:9aa24b6c-aef | 边录边转首次真机验证失败 + 补观测（每轮留痕、守护进程限频） src/pre-transcribe-tick.ts src/daemon.ts test/pre-transcribe-tick.ts | 文件：

- [x] 2026-10-13T14:57:43Z | session:9aa24b6c-aef | 收窄预转写让路门控：只有真正在转写时才让路 src/daemon.ts | 文件：

- [x] 2026-10-15T15:01:36Z | session:9aa24b6c-aef | 精确转写进度：执行器子批上报 + 服务端实测聚合（pct/ETA）+ 界面显示 | 文件：src/asr-progress.ts, src/asr.ts, src/daemon.ts, src/server.ts, src/config.ts, src/types.ts, src/asr-worker.ts, src/asr-worker-client.ts, tools/local-asr/transcribe-funasr.py, test/asr-progress.ts, test/local-funasr-executor.ts, test/asr-worker.ts, web/src/40-实时监控-api-monitor-默认-5-秒自动刷新.js

- [x] 2026-10-16T21:26:37Z | DEMO | 修分页判据击穿导致墓碑误自动解除（Bug#1+#2+#3）+ 回滚工具 | 文件：src/api.ts, src/daemon.ts, src/tombstone-reconcile.ts, tools/rollback-tombstone-release.ts

- [x] 2026-10-16T22:31:31Z | DEMO | UI 现代轻盈升级：修 7 处坏色 + 阴影/圆角/留白打磨 + 硬编码色收敛令牌 | 文件：web/src/10-style.css

- [x] 2026-10-16T22:44:55Z | DEMO | 修排期抽屉展开后无法收回（遮罩拦截顶栏按钮） | 文件：web/src/10-style.css

- [x] 2026-10-17T03:35:35Z | DEMO | 稿件表现表默认只显示20条 多余折叠展开 | 文件：web/src/41-切片库与稿件视图-跨场次检索-按-bvid-体检稿件.js

- [x] 2026-10-17T03:40:39Z | DEMO | 修简介模板liveTitle显示场次原始标题+默认模板缺书名号 | 文件：src/publish.ts, src/config.ts, config.example.json

- [x] 2026-10-17T04:09:42Z | DEMO | 简介模板加主播ID变量 anchorUid（房间号反查B站uid） | 文件：src/types.ts, src/api.ts, src/publish.ts, src/config.ts, config.example.json, config.json

- [x] 2026-10-17T04:16:36Z | DEMO | 简介主播行改成 @昵称+空间链接 格式 | 文件：src/types.ts, src/api.ts, src/publish.ts, src/config.ts, config.example.json, config.json

- [x] 2026-10-17T04:23:37Z | DEMO | 多主播：录制记录标注来源房间号，任务用真实roomId | 文件：src/trigger.ts, src/daemon.ts

- [x] 2026-10-17T04:30:17Z | DEMO | 修简介{{date}}手动导入退化成今天（从文件名提取真实日期） | 文件：src/publish.ts

- [x] 2026-10-17T04:41:58Z | DEMO | 简介主播行加「欢迎关注👉」前缀 | 文件：src/config.ts, config.example.json, config.json

- [x] 2026-10-17T04:49:43Z | DEMO | 简介时间点显示录制时的真实时刻 | 文件：src/publish.ts

- [x] 2026-10-17T11:17:59Z | DEMO | 设置界面可用变量提示补 anchorName/anchorUid | 文件：web/src/42-设置弹窗.js

- [x] 2026-10-17T11:31:17Z | DEMO | 补漏对账路径也标注来源房间号+修乙主播任务roomId | 文件：src/trigger.ts

- [x] 2026-10-17T12:33:23Z | DEMO | 切片库加刷新按钮（去B站按稿件对账刷新状态） | 文件：web/src/41-切片库与稿件视图-跨场次检索-按-bvid-体检稿件.js

- [x] 2026-10-17T17:27:26Z | DEMO | 修复投稿限流误判失败（请稍等2秒） | 文件：src/failure-class.ts, src/publish.ts, test/failure-class.ts, test/upload-ratelimit.ts, package.json

- [x] 2026-10-17T17:58:57Z | DEMO | QA 独立验证投稿限流修复（新增极端用例套件） | 文件：test/upload-ratelimit-qa.ts, package.json, verify.steps.json

- [x] 2026-10-21T05:00:00Z | session:bugfix-upload-quota | 修「投稿配额限流被当永久失败」：quota 级 fail-fast + 待投 + 停本轮 + 告警；新增复位工具 | 文件：src/failure-class.ts, src/publish.ts, src/alert.ts, src/daemon.ts, test/upload-ratelimit.ts, tools/rollback-quota-stuck-clips.ts

- [x] 2026-10-21T05:20:00Z | session:bugfix-upload-quota | QA 二轮：多分P 配额标识透传（daemon 不再误判失败/回退 ANALYZED）、额度满也按 CLIPPED 收、告警剩余数按未截断队列算、批次账跟台账目录（测试不再写生产 publish-log） | 文件：src/publish.ts, src/daemon.ts, test/publish-batches.ts

- [x] 2026-10-24T15:16:37Z | DEMO | 修复稿件表现接口按播放截断100条导致新稿件不可见 | 文件：src/server.ts, web/src/41-切片库与稿件视图-跨场次检索-按-bvid-体检稿件.js, public/ui.html, test/performance-reflux.ts, tools/verify-perf-ui.ts

- [x] 2026-10-24T15:21:59Z | DEMO | QA 验证稿件表现截断修复 | 文件：test/performance-cap.ts, package.json

- [x] 2026-10-24T15:47:14Z | DEMO | 代码热更新：空闲自动重载 + UI 自动构建 | 文件：src/hot-watch.ts, src/cli.ts, src/server.ts, web/src/39-其它页签-健康-成本-表现-Prompt.js, test/hot-watch.ts, package.json, launcher.ps1, tools/ensure-service.ps1

- [x] 2026-10-24T16:01:46Z | DEMO | QA 验证代码热更新 | 文件：test/hot-watch.ts

- [x] 2026-10-24T16:14:52Z | DEMO | QA 验证代码热更新（补极端用例） | 文件：test/hot-watch-qa.ts, package.json, verify.steps.json

- [x] 2026-10-24T16:25:50Z | DEMO | 热更新修复：崩溃×重载并发、忙时不重跑 tsc、启动入口一致性 | 文件：src/hot-watch.ts, test/hot-watch.ts, start.ps1, tools/restart-service.ts, README.md

- [x] 2026-10-24T16:35:32Z | DEMO | 热更新二轮：HTTP 就绪门 + 重载/崩溃互斥 + 入口与文档 | 文件：src/hot-watch.ts, test/hot-watch.ts, start.ps1, tools/restart-service.ts, README.md, docs/implementation-report.md

- [x] 2026-10-24T16:41:47Z | DEMO | QA 第二轮复验热更新（就绪门/轮转/退出路径） | 文件：test/hot-watch-qa.ts

- [x] 2026-10-24T16:46:10Z | DEMO | 热更新加固：内部异常兜底 + 就绪核对应答者 pid + README 例外 | 文件：src/hot-watch.ts, src/daemon.ts, test/hot-watch.ts, README.md, docs/implementation-report.md

- [x] 2026-10-24T16:52:06Z | DEMO | 热更新加固 R3：全局异常兜底（含 reloadActive 复位）+ bootstrap pid 就绪核对 | 文件：src/hot-watch.ts, src/server.ts, test/hot-watch.ts, README.md, docs/implementation-report.md

- [x] 2026-10-24T16:56:09Z | DEMO | 热更新 nit：日志轮转注释对齐 20MB + README 首启不等就绪说明 | 文件：src/hot-watch.ts, README.md

- [x] 2026-10-24T17:21:35Z | DEMO | 修复自动关机录制判据漏掉原始分段与录制器状态 | 文件：src/recording-signals.ts, src/daemon.ts, src/server.ts, test/recording-gate.ts, test/auto-shutdown.ts, package.json, verify.steps.json

- [x] 2026-10-25T01:40:00+08:00 | DEMO | 新增构建指纹徽章（顶栏 v{version}·{8位指纹}），代码改了没重启会转红「⚠ 代码已更新 · 需重启」| 解决"修复落盘但旧进程还在跑、只能靠翻进程启动时间猜"的痛点 | 文件：src/build-info.ts(新), src/daemon.ts, src/server.ts(/api/build + bootstrap), web/src/20-shell-body.html, web/src/10-style.css, web/src/32-数据加载.js, web/src/46-启动.js
