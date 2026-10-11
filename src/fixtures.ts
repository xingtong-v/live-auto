/**
 * 「测试夹具」与真实业务的**分账**（2026-10-11）。
 *
 * 为什么需要（实测数据）：日志里 10-06 / 10-08 / 10-10 每天建了 **38–45 个任务**，
 * 而真实直播只有 **2–7 场** —— 其余全是测试夹具（`测试场次` ×22、`【界面测试】固定夹具任务` ×8、
 * `逐片操作测试` ×12 …）。后果有两个，都很实际：
 *   ① 用户的任务列表被淹没（他最早的抱怨就是"列表太长"）；
 *   ② 「成本」月度汇总把夹具也算了进去，数字不再代表真实开销。
 *
 * 口径只此一处：识别规则写在这里，任务列表、成本统计、健康面板全部调用它，
 * 避免出现"列表里藏了、成本里又算了"这种自相矛盾。
 *
 * 识别顺序（从可靠到启发式）：
 *   1. 台账显式标记 `task.fixture === true`（新夹具都该走这条，最可靠）；
 *   2. id 前缀（`uie2e-` / `mon-` / `mp-test-` / `perf-t` / `timing-` / `dbg-` / `T1` …）；
 *   3. 标题特征（以 `【界面测试】` / `【测试】` 开头，或整名等于已知夹具名）。
 *
 * ⚠️ 刻意**不**用「标题里含『测试』」这种宽判据：游戏主播真的会播"测试服"，
 * 那会把真实场次误判成夹具（比不识别更糟）。
 */
const FIXTURE_ID_PREFIXES = [
  'uie2e-',
  'mon-',
  'mp-test-',
  'perf-t',
  'perf-hist',
  'timing-',
  'dbg-',
  'ab-',
  't-',
  'T1',
];

const FIXTURE_TITLES = ['测试场次', '逐片操作测试', '多分P路由测试场', '可恢复的任务'];

const FIXTURE_TITLE_PREFIXES = ['【界面测试】', '【测试】'];

export interface FixtureLike {
  id: string;
  title?: string;
  /** 台账里的显式标记（新夹具应写这个） */
  fixture?: boolean;
}

/** 这个任务是不是测试夹具（口径只此一处，界面/统计共用） */
export function isFixtureTask(t: FixtureLike): boolean {
  if (t.fixture === true) return true;
  const id = String(t.id ?? '');
  if (FIXTURE_ID_PREFIXES.some((p) => id.startsWith(p))) return true;
  const title = String(t.title ?? '').trim();
  if (FIXTURE_TITLES.includes(title)) return true;
  if (FIXTURE_TITLE_PREFIXES.some((p) => title.startsWith(p))) return true;
  return false;
}

/** 统计用：把夹具剔掉，并如实报出剔了几个（不许静默改口径） */
export function splitFixtures<T extends FixtureLike>(list: T[]): { real: T[]; fixtures: T[] } {
  const real: T[] = [];
  const fixtures: T[] = [];
  for (const t of list) (isFixtureTask(t) ? fixtures : real).push(t);
  return { real, fixtures };
}
