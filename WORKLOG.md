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

- [ ] 2026-10-11T08:02:02Z | session:9aa24b6c-aef | 共享件收口：机会式采用 + 防新增副本闸门 + 归档 ui-diag tools/ui-shared.ts test/ui-shared-usage.ts tools/archive/README.md | 文件：
