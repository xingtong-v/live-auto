/* ============================================================================
 * 顶栏与事件绑定
 * ========================================================================== */
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

