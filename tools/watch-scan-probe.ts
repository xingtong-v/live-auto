/**
 * 探查：`import.watch.dirs` 到底有没有参与扫盘。
 *
 * 起因（实测）：把一个新的录播文件丢进 `C:\Users\demo\Downloads\Bilibili\自动导入测试\`，
 * 线上轮询每 60 秒扫一次、连扫 6 分钟，`/api/watch` 的 `lastOutcomes` 里**始终没有这个文件**
 * —— 返回的 13 个候选全是 biliLive-tools **录制历史**里的条目。
 *
 * 读代码找到原因：`listRecordingsDetailed` 的 `opts.extraDirs`（watcher 就是用它传
 * `import.watch.dirs` 的）**只在接口里声明过，函数体里从没读过**；
 * 扫描根只来自 `cfg.import.scanDirs` + 探测到的 biliLive-tools 保存目录 + `~/Downloads/Bilibili` 兜底。
 * 而 watcher 传的是 `includeFallbackDirs: false` + 用户配置 `scanDirs: []`
 * ⇒ 三个来源全空 ⇒ **扫盘完全没发生**，只剩录制历史这一条腿。
 *
 * 本脚本用三组对照把这个结论量出来（只读，不导入、不建任务）：
 *   A 现状      ：extraDirs=[测试目录]、includeFallbackDirs=false
 *   B 绕过 BUG  ：把测试目录塞进 cfg.import.scanDirs（同一个目录，换一条路）
 *   C 打开兜底  ：extraDirs=[测试目录]、includeFallbackDirs=true
 *
 * 用法：node tools/watch-scan-probe.ts [测试目录]
 */
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { listRecordingsDetailed } from '../src/recordings.ts';
import type { AppConfig } from '../src/config.ts';

const cfg: AppConfig = loadConfig().config;
const ledger = new Ledger();
const client = BiliLiveClient.fromConfig(cfg);
const testDir = process.argv[2] ?? 'C:\\Users\\demo\\Downloads\\Bilibili\\自动导入测试';

const WATCH = cfg.import.watch;
console.log('配置：');
console.log(`  import.scanDirs      = ${JSON.stringify(cfg.import.scanDirs)}`);
console.log(`  import.watch.dirs    = ${JSON.stringify(WATCH.dirs)}`);
console.log(`  import.watch.enabled = ${WATCH.enabled}  maxDepth=${WATCH.maxDepth}  minSizeMB=${WATCH.minSizeMB}`);
console.log(`  测试目录             = ${testDir}\n`);

interface Row {
  label: string;
  opts: Parameters<typeof listRecordingsDetailed>[1];
}
const rows: Row[] = [
  {
    label: 'A 现状（watcher 的调用方式）',
    opts: { client, ledger, extraDirs: [testDir], includeFallbackDirs: false, maxDepth: WATCH.maxDepth, minSizeMB: WATCH.minSizeMB, probe: false },
  },
  {
    label: 'B 同一个目录，改走 cfg.import.scanDirs',
    opts: {
      client,
      ledger,
      extraDirs: [],
      includeFallbackDirs: false,
      maxDepth: WATCH.maxDepth,
      minSizeMB: WATCH.minSizeMB,
      probe: false,
    },
    // 见下方 patchCfg
  },
  {
    label: 'C 打开兜底目录（界面手动导入的调用方式）',
    opts: { client, ledger, extraDirs: [testDir], includeFallbackDirs: true, maxDepth: WATCH.maxDepth, minSizeMB: WATCH.minSizeMB, probe: false },
  },
];

for (const r of rows) {
  const useCfg: AppConfig =
    r.label.startsWith('B') ? { ...cfg, import: { ...cfg.import, scanDirs: [testDir] } } : cfg;
  const res = await listRecordingsDetailed(useCfg, r.opts);
  const fromScan = res.candidates.filter((c) => c.source === 'scan').length;
  const fromHistory = res.candidates.filter((c) => c.source === 'record-history').length;
  const hit = res.candidates.find((c) => c.videoPath.toLowerCase().startsWith(testDir.toLowerCase()));
  console.log(`\n=== ${r.label}`);
  console.log(`  实际扫描根 scanRoots : ${res.scanRoots.length === 0 ? '(空 —— 没有扫任何目录)' : res.scanRoots.join(' | ')}`);
  console.log(`  候选总数             : ${res.candidates.length}（扫盘来源 ${fromScan}，录制历史来源 ${fromHistory}）`);
  console.log(`  录制历史条目         : ${res.historyTotal}（文件已不在磁盘 ${res.historyMissing}）`);
  console.log(`  测试目录里的文件     : ${hit ? `✅ 发现 ${hit.fileName}` : '❌ 没被发现'}`);
}

console.log('\n判据：A 组 scanRoots 为空且发现不到测试文件，而 B/C 组能发现 —— 即 extraDirs 这条路是死的。');
void cfg;
void testDir;
