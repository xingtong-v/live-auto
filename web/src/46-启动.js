/* ============================================================================
 * 启动
 * ========================================================================== */
(async function init() {
  // 自检：把关键元素的存在性打出来，便于排查「点了没反应」
  console.info('%c[live_auto] UI 构建 ' + UI_BUILD, 'color:#00aeec;font-weight:bold');
  const probe = ['#taskList', '#btnRepairStuck', '#btnSetting', '#btnImport', '#tabs'];
  console.info('[live_auto] 关键元素:', probe.map((x) => x + '=' + (document.querySelector(x) ? 'OK' : 'MISSING')).join(' '));

  try {
    await loadBootstrap();
    await refreshAll();
  } catch (e) {
    $('#detail').innerHTML = `<div class="errbar"><div class="ico">!</div><div class="txt"><b>初始化失败</b><br>${esc(e.message)}<br>
      <span style="color:var(--text-3)">请确认服务已启动，并且你是通过 http://127.0.0.1:${state.bootstrap ? '' : ''}${location.port} 访问（不是通过其它主机名）。</span></div></div>`;
  }
  /* 构建指纹巡检（2026-10-25）：页面开着的时候有人改了代码，这里能自己转红，
     不用刷新页面才发现"咦怎么还是旧行为"。30 秒一次，只读一个很小的 JSON。 */
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const b = await api('/api/build');
      renderBuildTag({ id: b.running && b.running.id, diskId: b.disk && b.disk.id, stale: b.stale, at: b.running && b.running.latestMtimeMs, note: b.note });
    } catch { /* 服务重启中会短暂失败，忽略 */ }
  }, 30000);
  // 自动刷新：有任务在处理时 4 秒，否则 20 秒
  setInterval(async () => {
    if (document.hidden) return;
    const active = state.tasks.some((t) => ['TRANSCRIBING', 'ANALYZING', 'CLIPPING', 'PUBLISHING', 'TRANSCRIBED', 'PENDING', 'RECORDED'].includes(t.status));
    if (state.view !== 'tasks') return;
    if (state.dirty.size) return;
    await refreshAll(true).catch(() => {});
  }, 8000);
})();
</script>