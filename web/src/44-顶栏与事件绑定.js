/* ============================================================================
 * 顶栏与事件绑定
 * ========================================================================== */

/* ★ 2026-10-16（UI 评审 L-3）：窄屏（<1320px）的排期抽屉开关。
   为什么要有：三栏原来写死 280|1fr|300，1280 笔记本上中栏只剩 700px，
   工具条换行、底栏压住正文。现在窄屏把排期收成右侧抽屉，宽度还给中栏。 */
function openScheduleDrawer() {
  const el = $('#colRight'); if (!el) return;
  el.classList.add('open');
  const b = $('#btnSchedule'); if (b) b.setAttribute('aria-expanded', 'true');
}
function closeScheduleDrawer() {
  const el = $('#colRight'); if (!el) return;
  el.classList.remove('open');
  const b = $('#btnSchedule'); if (b) b.setAttribute('aria-expanded', 'false');
}
(function bindScheduleDrawer() {
  const b = $('#btnSchedule');
  if (b) b.onclick = () => {
    const el = $('#colRight');
    if (el && el.classList.contains('open')) closeScheduleDrawer(); else openScheduleDrawer();
  };
  /* 点抽屉外面任意地方收起（只在抽屉确实打开时生效，避免抢别处的点击） */
  document.addEventListener('click', (ev) => {
    const el = $('#colRight');
    if (!el || !el.classList.contains('open')) return;
    if (el.contains(ev.target) || (b && b.contains(ev.target))) return;
    closeScheduleDrawer();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeScheduleDrawer();
  });
})();

/* ★ 2026-10-16：主题切换。
   首屏的 data-theme 已经由 00-shell-head.html 里的内联脚本设好（避免闪白），
   这里只负责"点一下换一个"和把按钮文案同步过去。
   为什么不做成右上角的开关（switch）：它会和「全自动」「字幕」两个开关并排，
   三个长得一样的开关放在一起，用户会以为都是"功能开关"而不是"外观设置"。 */
(function bindThemeToggle() {
  const btn = $('#btnTheme');
  if (!btn) return;
  const root = document.documentElement;
  const isDark = () => root.getAttribute('data-theme') === 'dark';
  const paint = () => {
    const dark = isDark();
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    const t = $('#themeText'); if (t) t.textContent = dark ? '浅色' : '深色';
    const i = $('#themeIcon'); if (i) i.textContent = dark ? '☀' : '◐';
    btn.title = dark ? '切换到浅色主题' : '切换到深色主题';
  };
  btn.onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    if (next === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('liveauto.theme', next); } catch (e) { /* 隐私模式，忽略 */ }
    paint();
    /* 切主题会让 canvas / iframe 里的旧配色过时，提示一下但不强制刷新 */
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  };
  /* 没手动选过时，跟随系统：用户在系统里切了深色，这里要跟着变 */
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = (ev) => {
      let saved = null;
      try { saved = localStorage.getItem('liveauto.theme'); } catch (e) { /* 忽略 */ }
      if (saved) return;                  // 手动选过就以手动为准
      if (ev.matches) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
      paint();
    };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
  paint();
})();

$('#btnSetting').onclick = () => openCfg().catch((e) => toast(e.message));
$('#btnCheckNow').onclick = async () => {
  toast('正在检查录制历史…');
  try {
    const r = await api('/api/check-now', { method: 'POST' });
    toast(`检查完成：轮询触发 ${r.polled.length}，对账触发 ${r.reconciled.length}。${r.note}`, 4000);
    if (r.polled.length + r.reconciled.length) setTimeout(() => refreshAll(true), 1500);
  } catch (e) { toast('检查失败：' + e.message); }
};
$('#btnRepairStuck').onclick = async () => {
  const b = $('#btnRepairStuck');
  b.disabled = true; b.textContent = '检查中…';
  try {
    const r = await api('/api/tasks/repair-stuck', { method: 'POST' });
    toast(r.note, 5000);
    if (r.fixed.length) setTimeout(() => refreshAll(true), 800);
  } catch (e) { toast('修复失败：' + e.message, 5000); }
  b.disabled = false; b.textContent = '修复卡住';
};

