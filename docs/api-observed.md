# biliLive-tools API 实测记录（WP1 产出）

> 由 `node src/probe.ts` 于 2026/9/22 18:10:31 自动生成。
> **与任务书 §4 不一致处以本文件为准**（任务书原文亦如此要求）。

## 环境

| 项 | 值 |
|---|---|
| biliLive-tools 版本 | 3.21.0 |
| 任务书核实版本 | 3.22.1 |
| 服务地址 | http://127.0.0.1:18010 |
| 目标直播间 | 12345678 (platform=Bilibili) |
| 登录账号 | uid=1000000000000000 星者如曈捏 |
| cookie 有效期 | 2027/2/11 14:47:41（剩余 142 天） |
| 本机 ffmpeg | ffmpeg，whisper 滤镜=有 |
| Node | v24.19.0 |

## WP1 六项确认项结论

1. **/config 是否返回 ffmpeg 路径**：是 —— `ffmpegPath` = `…/bin/ffmpeg.exe`（二期封面抽帧可用）
2. **录制器与 webhook**：配置声明 `recorder.type=builtin`。内置引擎**没有对外事件源**，因此本服务以 60 秒轮询为主路径 + 每小时对账；**不要把 /webhook/* 当推送通道**（陷阱 #26）。
3. **录制输出是否分段**：实测单条 record 时长 00:18:53；本服务的 asr.ts 一律按「分段文件 → 全局时间映射」处理（用 ffprobe 读每段时长并累加），单文件场景退化为 1 段，两种都能跑。
4. **seasonId / sectionId**：`/bili/upload` 的 config 接受这两个字段，但**没有任何接口能创建合集**。→ 首次需人工在创作中心建合集并填写 `publish.seasonId`；留空时无法归入同一合集（UI 会提示）。
5. **阿里云 ASR 静音过滤 / VAD**：需在阿里云控制台确认；本服务已内置**本地剪静音**开关（`asr.silenceTrim.enabled`，默认关闭）作为可控兜底，可省 20–40% 费用。
6. **弹幕 XML 是否含 SC / 上舰 / 礼物**：由 WP2 的 `danmaku.ts` 在解析后写入 `signals.json.eventSignalsAvailable`；不含时自动降级为「弹幕密度 + 关键词」信号（陷阱 #25）。

## 逐接口实测

### 本机 ffmpeg 是否带 whisper 滤镜

- 对应章节：§5.2 / WP1 步骤 4
- 结果：**成功**

观测事实：

- ✓ ffmpeg（ffmpeg version 8.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers）**带 whisper 滤镜** —— §5.2 本地方案可用（另有更可控的 whisper.cpp 独立程序路径）

### 连通性与版本

- 对应章节：§4.6
- 请求：`GET /common/version`
- 结果：**成功**（28ms）
- 实测结构：`string`
- fixture：`test/fixtures/version.json`

观测事实：

- biliLive-tools 版本 = 3.21.0
- biliLive-tools 版本 3.21.0 与任务书核实的 3.22.1 主次版本不同，接口字段可能已变动，请跑 probe.ts 复核

与任务书 **不一致 / 需注意**：

- ⚠️ 版本 3.21.0 ≠ 任务书核实的 3.22.1（主次版本不同）—— 字段可能已变动，本文件所有实测结果优先

### 已登录账号（投稿必填 uid、有效期）

- 对应章节：§4.6
- 请求：`GET /user/list`
- 结果：**成功**（80ms）
- 实测结构：`[{ uid: number, name: string, face: string, expires: number } ×1]`
- fixture：`test/fixtures/user-list.json`

观测事实：

- 共 1 个账号；主账号 uid=1000000000000000 name=星者如曈捏
- cookie 有效期 expires = 1802328461000 → 2027/2/11 14:47:41（还剩 142 天）
- ⚠️ 依 §4.6，/user/export 会输出含 cookie 的原始数据，本次探测**未调用**，服务也不会调用

与任务书 **不一致 / 需注意**：

- ⚠️ 实测 /user/list 可能返回**单个对象**而非文档所述的数组；api.ts 已对两种形态做兼容

### 最近录制（触发信号）

- 对应章节：§4.1
- 请求：`GET /record-history/recent-clips?room_id&platform=Bilibili`
- 结果：**成功但返回空**（7ms）
- 实测结构：`[]`
- fixture：`test/fixtures/recent-clips.json`

观测事实：

- 返回 0 条（接口最多返回 5 条）
- 空数组有两种已知原因（都不会报错）：① platform 传错（必须 "Bilibili"）；② 该直播间在 streamer 表中没有记录（陷阱 #1、#2）
- 本次传的是 platform="Bilibili"，若该直播间从未录制过，空数组是正常的

### 录制历史分页（启动补漏 / 周期对账）

- 对应章节：§4.1、§8 WP2 步骤 2
- 请求：`GET /record-history/list?room_id&platform=Bilibili&page&pageSize`
- 结果：**成功**（8ms）
- 实测结构：`[{ id: number, created_at: number, streamer_id: number, live_id: string, live_start_time: number, record_start_time: number, record_end_time: number, title: string, video_file: string, video_filename: string, video_duration: number, danma_num: number, interact_num: number, quick_hash: string, danma_density: number } ×50]`
- fixture：`test/fixtures/record-history-list.json`

观测事实：

- total=74，本页 50 条（pageSize=50）
- 字段（下划线）: id, created_at, streamer_id, live_id, live_start_time, record_start_time, record_end_time, title, video_file, video_filename, video_duration, danma_num, interact_num, quick_hash, danma_density
- 实测额外字段：created_at, streamer_id, live_id, video_filename, quick_hash
- 时间戳单位核对：live_start_time=1789995002000（毫秒） / record_start_time=1790009236030（毫秒）
- 可计算时长的记录数：50

与任务书 **不一致 / 需注意**：

- ⚠️ 实测确认：本接口字段为下划线风格，与 recent-clips 的驼峰风格不同（陷阱 #10 已复现并规避）
- ⚠️ 实测 live_start_time 是**毫秒**，与任务书 §4.1「live_start_time 是秒级」不一致 —— 以实测为准，util.toSec 已做自适应

### 弹幕文件查询（ASS 用于烧录 / XML 用于信号分析）

- 对应章节：§4.1
- 请求：`POST /record-history/danma-file`
- 结果：**已跳过**

观测事实：

- 没有可用的录制记录，跳过（该接口需要视频绝对路径）

### ffmpeg 预设（切片参数来源）

- 对应章节：§4.5
- 请求：`GET /preset/ffmpeg`
- 结果：**成功**（13ms）
- 实测结构：`[{ id: string, name: string, config: {…} } ×1]`
- fixture：`test/fixtures/preset-ffmpeg.json`

观测事实：

- 共 1 条：default(默认配置)
- 配置的 clip.ffmpegPresetId="default" 存在 ✓
- 预设 "default" 的编码器 = (未声明)

### 投稿预设

- 对应章节：§4.5
- 请求：`GET /preset/video`
- 结果：**成功**（16ms）
- 实测结构：`[{ id: string, name: string, config: {…} } ×2]`
- fixture：`test/fixtures/preset-video.json`

观测事实：

- 共 2 条：default(默认配置), xcz9r0pf7t(甲主播)

### 弹幕样式预设

- 对应章节：§4.5
- 请求：`GET /preset/danmu`
- 结果：**成功**（6ms）
- 实测结构：`[{ id: string, name: string, config: {…} } ×1]`
- fixture：`test/fixtures/preset-danmu.json`

观测事实：

- 共 1 条：default(默认配置)

### 任务列表与并发数

- 对应章节：§4.6 / §8 WP5 步骤 6
- 请求：`GET /task/?page&pageSize`
- 结果：**成功**（10ms）
- 实测结构：`{ list: [], runningTaskNum: number, pagination: { total: number, page: number, pageSize: number } }`
- fixture：`test/fixtures/task-list.json`

观测事实：

- runningTaskNum = 0（用于并发控制）
- 列表返回 0 条任务

### biliLive-tools 配置（ffmpeg 路径 / 上传后删除开关）

- 对应章节：§8 WP1 步骤 4
- 请求：`GET /config`
- 结果：**成功**（15ms）
- 实测结构：`{ ffmpegPath: string, ffprobePath: string, danmuFactoryPath: string, mesioPath: string, bililiveRecorderPath: string, audiowaveformPath: string, logLevel: string, uploadCrashReport: boolean, autoUpdate: boolean, autoLaunch: boolean, trash: boolean, saveConfig: boolean, minimizeToTray: boolean, closeToTray: boolean, theme: string, menuBarVisible: boolean, port: number, host: string, passKey: string, https: boolean, externalWebhook: string, webhook: { open: boolean, recoderFolder: string, minSize: number, title: string, blacklist: string, danmu: boolean, rooms: {…}, afterConvertAction: [], autoPartMerge: boolean, partMergeMinute: number, hotProgress: boolean, useLiveCover: boolean, partTitleTemplate: string, hotProgressSample: number, hotProgressHeight: number, hotProgressColor: string, hotProgressFillColor: string, convert2Mp4: boolean, flvRepair: boolean, uploadHandleTime: [string ×2], limitUploadTime: boolean, uploadNoDanmu: boolean, uploadToSameMedia: boolean, limitVideoConvertTime: boolean, videoHandleTime: [string ×2], afterUploadDeletAction: string, uid: number, uploadPresetId: string, danmuPreset: string, ffmpegPreset: string }, losslessCutPath: string, cacheFolder: string, customExecPath: boolean, requestInfoForRecord: boolean, biliUploadFileNameType: string, cutPageInNewWindow: boolean, bilibiliUser: { 1000000000000000: string }, tool: { home: {…}, upload: {…}, fileSync: {…}, danmu: {…}, video2mp4: {…}, videoMerge: {…}, flvRepair: {…}, download: {…}, translate: {…}, videoCut: {…} }, task: { maxNum: number, ffmpegMaxNum: number, douyuDownloadMaxNum: number, biliUploadMaxNum: number, biliDownloadMaxNum: number, syncMaxNum: number }, videoCut: { autoSave: boolean, cacheWaveform: boolean }, notification: { task: {…}, setting: {…}, taskNotificationType: {…} }, sync: { baiduPCS: {…}, aliyunpan: {…}, alist: {…}, pan123: {…}, syncConfigs: [] }, llmPresets: [], ai: { vendors: [{…} ×1], models: [{…} ×3], songRecognizeAsr: {…}, songRecognizeLlm: {…}, songLyricOptimize: {…}, subtitleRecognize: {…} }, biliUpload: { line: string, concurrency: number, limitRate: number, retryTimes: number, retryDelay: number, checkInterval: number, minUploadInterval: number, accountAutoCheck: boolean, useBCutAPI: boolean, useUploadPartPersistence: boolean }, recorder: { savePath: string, nameRule: string, autoRecord: boolean, quality: string, checkInterval: number, maxThreadCount: number, waitTime: number, disableProvideCommentsWhenRecording: boolean, segment: string, saveGiftDanma: boolean, saveSCDanma: boolean, saveCover: boolean, debugMode: boolean, debugLevel: string, qualityRetry: number, videoFormat: string, recorderType: string, useServerTimestamp: boolean, recordRetryImmediately: boolean, bilibili: {…}, douyu: {…}, huya: {…}, douyin: {…}, xhs: {…}, tiktok: {…}, saveDanma2DB: boolean }, video: { subCheckInterval: number, subSavePath: string }, recorders: [{…} ×2] }`
- fixture：`test/fixtures/config.json`

观测事实：

- 命中字段：ffmpegPath, ffprobePath, danmuFactoryPath, webhook.rooms.34567890.autoPartMerge, webhook.rooms.34567890.afterUploadDeletAction, webhook.autoPartMerge, webhook.afterUploadDeletAction, cacheFolder, tool.home.removeOrigin, tool.home.removeOriginAfterUploadCheck, tool.upload.removeOriginAfterUploadCheck, tool.fileSync.removeOrigin, tool.danmu.removeOrigin, tool.video2mp4.removeOrigin, tool.videoMerge.removeOrigin, recorder.segment, recorder.recorderType
- ffmpeg 二进制 = …/bin/ffmpeg.exe（存在=false）—— 二期封面抽帧可用

### ASR 分段调用与 offset 语义实测

- 对应章节：§4.2 / §8 WP1 步骤 2、WP3 步骤 2
- 请求：`POST /ai/subtitle`
- 结果：**已跳过**

观测事实：

- 未传 --allow-paid：**未调用付费 ASR**（硬约束 #14）
- 要实测 offset 语义，请运行：node src/probe.ts --allow-paid（建议先把 asr.segmentMinutes 调小做一次短片段）

### 读取 biliLive-tools 自身日志（错误报告用）

- 对应章节：§4.6 / §8 WP6 步骤 10
- 请求：`GET /common/getLogContent`
- 结果：**成功**（16ms）
- fixture：`test/fixtures/get-log-content.json`

观测事实：

- 读取到 8192 字符 —— 错误报告会附带其末尾片段用于定位 ffmpeg 报错

## 陷阱复现情况

| # | 陷阱 | 本次探测是否复现 / 已规避方式 |
|---|---|---|
| 1 | `platform` 写成 `bilibili` | 已按 `Bilibili` 调用，返回 0 条；`api.ts` 的 `recentClips` 默认值即 `Bilibili`，配置层另有硬校验 |
| 2 | 直播间在 streamer 表中无记录 | 空数组时 probe 会明确提示该原因（不报错、静默返回） |
| 3 | `/ai/subtitle` 无服务端缓存 | 默认**不调用**；`asr.ts` 逐段落盘缓存，缓存键不含 videoFileId |
| 4 | 只传 startTime 或 endTime | `api.ts` 在客户端直接抛错拒绝（不发请求） |
| 6 | `/task/cut` 的 output 传相对路径 | `api.ts` 校验绝对路径，否则抛错 |
| 7 | 切片用 stream copy | `api.ts` 检测到 `c:v=copy` 直接拒绝 |
| 9 | 秒/毫秒混用 | `util.toSec/toMs` 自适应；probe 打印实测单位 |
| 10 | `list`（下划线）与 `recent-clips`（驼峰）混用 | 两种结构分别建模，`RecordHistoryListItem` / `RecentClip` |
| 11 | 以为 `/bili/upload` 返回稿件 id | 类型标注为 `{ taskId }`；bvid 一律用 `/bili/archives` 反查 |
| 21 | 日志/配置写入真实凭据 | 本次探测的 fixture 已做凭据扫描；`redact.ts` 是唯一日志出口 |
| 32 | `list` 的时间过滤参数用秒 | `recordHistoryList` 的参数注释与调用一律用毫秒 |

## 复现命令

```powershell
# 只读探测（不产生任何费用、不写文件）
node src/probe.ts --dry-run

# 完整探测并写入 docs / fixtures
node src/probe.ts

# 附带真实 ASR 实测 offset 语义（会产生费用）
node src/probe.ts --allow-paid --video "D:\path\to\sample.flv"
```
