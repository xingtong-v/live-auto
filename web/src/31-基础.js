/* ============================================================================
 * 基础
 * ========================================================================== */
const BOOT = window.__BOOT__ || { csrf: '', version: '?', roomId: '', platform: '' };

/** UI 构建标记：在浏览器控制台里能看到，用来确认页面是不是最新的（避免缓存导致以为功能没做） */
const UI_BUILD = 'ui-2026-10-13-llmdtype-switch';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  view: 'tasks',
  tasks: [],
  activeId: null,
  detail: null,
  status: '',
  q: '',
  schedule: { pending: [], published: [], retention: [] },
  /** 目录轮询状态（/api/watch）：用来在右栏显示"它在等什么" */
  watch: null,
  bootstrap: null,
  dirty: new Set(),   // 已编辑但未保存的切片：taskId:idx
  /**
   * 任务列表的多选状态（批量删除用）。
   *
   * 只在**当前可见列表**里维护选中项：切筛选/搜索时会把看不见的 id 丢掉 ——
   * 否则用户切到「处理中」再点删除，会把上一个筛选里选中的场次一起删掉（看不见却删了，最糟的交互）。
   */
  multi: { on: false, sel: new Set() },
  saving: false,
  /**
   * 实时监控页签的运行态。
   *
   * `sig` 是"去掉易变字段后的数据指纹"：5 秒一刷如果整页 innerHTML 重画，
   * 光标、滚动位置、展开的 details 都会被打断 —— 所以数据没变就只更新"最后更新"那一行。
   */
  mon: { interval: 5, paused: false, timer: null, busy: false, data: null, sig: '', lastAt: 0, lastError: '' },
};

async function api(path, opts = {}) {
  /* ★ 网络层失败与"接口报错"必须分开说。
     实测（2026-10-08 凌晨）：服务被外部杀掉/正在重启的那两分钟里，用户点「立即删除」，
     fetch 直接抛 → 旧写法把英文原文丢进 toast：「删除失败：Failed to fetch」——
     用户完全不知道是"服务不在了、等一会儿就好"，还是"这个文件删不掉、要去看日志"。
     这里（1）先自动重试一次（重启通常几秒就回来），（2）仍失败就给一句人话。 */
  const doFetch = async (attempt = 0) => {
    try {
      const res = await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': BOOT.csrf },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      return { res, data };
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        return doFetch(1);
      }
      const err = new Error('服务不可达（多半正在重启）—— 稍等几秒重试；一直这样请到「健康」页看服务状态');
      err.network = true;
      err.cause = e;
      throw err;
    }
  };

  let { res, data } = await doFetch();

  // 服务重启后 CSRF token 会重新生成，本页持有的旧 token 随即失效。
  // 这时**不该让用户自己去刷新页面**：自动重新拉一次 token 并重放本次请求即可。
  // 只对写操作重试（读操作本来就不校验 token），且最多重试一次，避免死循环。
  const isCsrfFailure = res.status === 403 && /CSRF/i.test(String(data?.error ?? ''));
  if (isCsrfFailure && (opts.method && opts.method !== 'GET')) {
    try {
      const boot = await fetch('/api/bootstrap', { headers: { 'Cache-Control': 'no-cache' } });
      const fresh = await boot.json();
      if (fresh && typeof fresh.csrf === 'string') {
        BOOT.csrf = fresh.csrf;
        window.__BOOT__ = BOOT;
        if (!opts.__retried) {
          return api(path, { ...opts, __retried: true });
        }
      }
    } catch {
      /* 拿不到新 token 就按原错误上报 */
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    err.csrfFailure = isCsrfFailure;
    throw err;
  }
  return data;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__t);
  window.__t = setTimeout(() => el.classList.remove('show'), ms);
}
window.toast = toast;

const toSec = (s) => { const p = String(s).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const toTime = (n) => { n = Math.max(0, Math.round(Number(n) || 0)); return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60].map((x) => String(x).padStart(2, '0')).join(':'); };
const fmtGB = (b) => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + u[i]; };

/** 极简 Markdown 渲染（够用即可：标题、列表、粗体、行内代码、引用、段落） */
function md(text) {
  const lines = String(text || '').split('\n');
  let out = '';
  let inUl = false;
  const closeUl = () => { if (inUl) { out += '</ul>'; inUl = false; } };
  for (let raw of lines) {
    let l = raw.replace(/^<!--.*-->$/, '').trimEnd();
    if (!l.trim()) { closeUl(); continue; }
    if (/^>\s?/.test(l)) { closeUl(); out += `<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { closeUl(); out += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) { if (!inUl) { out += '<ul>'; inUl = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    closeUl();
    out += `<p>${inline(l)}</p>`;
  }
  closeUl();
  return out;
}
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

