/** 复验：流水线里的转写进度（等两轮刷新，让 /api/tasks 的时长到位）（2026-10-15） */
import { sleep } from "../src/util.ts";
import { launchBrowser, ok, report } from "./ui-shared.ts";

const { cdp, close } = await launchBrowser({ port: 9436, headed: false, windowSize: "1400,900" });
try {
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:3000" });
  await sleep(3000);
  await cdp.evalJs(`(() => { const t = document.querySelector('#tabs .tab[data-view="monitor"]'); if (t) t.click(); return true; })()`);
  /* 等 12 秒：够 60 秒缓存之外的首次 /api/tasks + 至少两轮 5 秒刷新 */
  await sleep(12000);
  const r = await cdp.evalJs<{ txt: string; rows: string[] }>(`(() => {
    const txt = String(document.getElementById("otherPage").textContent || "").replace(/\\s+/g, " ");
    const tr = [...document.querySelectorAll("#otherPage .tbl tbody tr")];
    return { txt, rows: tr.slice(0, 3).map((x) => String(x.textContent).replace(/\\s+/g, " ").trim()) };
  })()`);
  ok("★ 流水线出现『转写进度 N%』", /转写进度\s*\d+%/.test(r.txt), r.txt.slice(r.txt.indexOf("流水线"), r.txt.indexOf("流水线") + 200));
  ok("★ 并给出『还需约 X（估算）』", /还需约\s*[\d分秒小时]+\s*（估算）/.test(r.txt.replace(/\s+/g, "")), r.txt.slice(r.txt.indexOf("转写进度"), r.txt.indexOf("转写进度") + 80));
  console.log("   转写中那行：");
  for (const x of r.rows) if (/转写中/.test(x)) console.log("     " + x.slice(0, 170));
  ok("全程无未捕获异常", cdp.errors.length === 0, cdp.errors[0]?.slice(0, 120));
} finally {
  await close();
}
await report();
