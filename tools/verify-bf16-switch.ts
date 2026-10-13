/**
 * 真浏览器验收「bf16 一键切换开关」（2026-10-13）。
 *
 * 为什么值得单独验：这个开关背后踩过一次"看着开了其实没生效"——
 * `llm_dtype` 曾传在 `generate()` 里，而 funasr 只在**构造模型**时读它 ⇒ 被静默忽略
 * （fp32/bf16 显存一模一样）。所以静态断言不够，必须确认：
 *   ① 配置里是 bf16 时，开关**渲染成"开"**（证明 config → bootstrap → 视图这条线通）；
 *   ② 点一下变成"关"、再点一下回到"开"，且旁边文案同步变（证明绑定真的接上了）；
 *   ③ 页面全程无未捕获异常。
 *
 * 用法：node --experimental-strip-types tools/verify-bf16-switch.ts [--headed]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { sleep } from '../src/util.ts';
import { clickReal, launchBrowser, ok, report } from './ui-shared.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9352;
const HEADED = process.argv.includes('--headed');

void Ledger;
void fs;
void os;
void path;

const { cdp, close } = await launchBrowser({ port: PORT, headed: HEADED });
try {
  await cdp.send('Page.navigate', { url: BASE });
  await new Promise((r) => setTimeout(r, 3500));

  /* ① 打开设置面板 */
  const opened = await cdp.evalJs<boolean>(`(() => {
    const cands = [...document.querySelectorAll('button, a, .tab, [data-view]')];
    const btn = cands.find((el) => /设置/.test(String(el.textContent || '')) && el.offsetParent !== null);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  ok('能打开设置面板（找到可见的「设置」入口）', opened);
  await new Promise((r) => setTimeout(r, 1500));

  /* ② 开关存在、且渲染成"开"（配置里现在是 bf16） */
  const st = await cdp.evalJs<{ exists: boolean; on: boolean; text: string; hint: string }>(`(() => {
    const el = document.querySelector('#c_funasrBf16');
    if (!el) return { exists: false, on: false, text: '', hint: '' };
    const wrap = el.closest('.field') || el.parentElement;
    return {
      exists: true,
      on: el.classList.contains('on'),
      text: String(el.nextElementSibling ? el.nextElementSibling.textContent : ''),
      hint: String(wrap ? wrap.textContent : '').slice(0, 400),
    };
  })()`);
  ok('★ 设置里有 #c_funasrBf16 开关', st.exists);
  ok('★ 配置为 bf16 时开关渲染成"开"（config → 视图这条线通）', st.on, `on=${st.on} text=${st.text}`);
  ok('文案写明当前状态', /开启|关闭/.test(st.text), st.text.slice(0, 80));
  ok('旁边带实测取舍数字（−33% 显存 / +10% 推理）', /−33%/.test(st.hint) && /\+10%/.test(st.hint), st.hint.slice(-120));

  /* ③ 点击翻转 —— ⚠️ 本套件**不验**这一条，原因如实记在这里：
     这个界面里的 `.switch` 在 headless 环境下无法被自动化点击触发。三种方式都试过：
       · `el.click()`（程序化 click）              → 不翻
       · 派发 pointerdown/mousedown/up/click        → 不翻
       · CDP `Input.dispatchMouseEvent`（真实鼠标，含滚动与撑高视口） → 落点校验 false，不翻
     关键对照：**既有的** `#c_funasrTimestamps`（本次改动之前就在用、用户手点正常）表现完全一样，
     所以这是 harness 限制，不是本开关的问题。为了不留"看起来验过其实没验"的假绿，
     这里不写这条断言；翻转能力由静态门禁兜（见 test/config-coverage.ts 的 3b：
     控件在 / saveCfg 存它 / config 有键 / 文案写明取舍）。 */
  ok('（说明）点击翻转未做自动化验证：headless 下 .switch 对三种合成点击均无响应（既有开关亦然）', true);

  /* ④ 关掉设置面板（不保存，避免把刚才的点击写进配置） */
  const closed = await cdp.evalJs<boolean>(`(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const cancel = btns.find((b) => /取消|关闭/.test(String(b.textContent || '')));
    if (cancel) { cancel.click(); return true; }
    return false;
  })()`);
  ok('点「取消」关掉面板（本次点击没有写进配置）', closed);

  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
} finally {
  await close();
}

await report();
