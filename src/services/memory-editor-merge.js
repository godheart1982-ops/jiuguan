// 记忆编辑器使用本地副本；后台索引/长期压缩可能同时完成。
// 保存时做三方合并：用户没碰的内容采用后台最新值，用户明确修改/删除的内容优先。

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mergeById(baseValue, localValue, latestValue, key) {
  const base = Array.isArray(baseValue) ? baseValue : [];
  const local = Array.isArray(localValue) ? localValue : [];
  const latest = Array.isArray(latestValue) ? latestValue : [];
  const baseMap = new Map(base.map((item) => [String(item?.[key] || ''), item]));
  const localMap = new Map(local.map((item) => [String(item?.[key] || ''), item]));
  const latestIds = new Set();
  const merged = latest.map((item) => {
    const id = String(item?.[key] || '');
    latestIds.add(id);
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    if (baseItem && localItem === undefined) return null; // 用户在编辑器里删除
    if (!baseItem) return localItem || item; // 后台新增，或编辑器刚刚整理出来
    return sameJson(baseItem, localItem) ? item : localItem;
  }).filter(Boolean);
  for (const item of local) {
    const id = String(item?.[key] || '');
    if (!latestIds.has(id)) merged.push(item);
  }
  return merged;
}

export function mergeMemoryEditorSnapshots(base, local, latest) {
  const safeBase = base && typeof base === 'object' ? base : {};
  const safeLocal = local && typeof local === 'object' ? local : {};
  const safeLatest = latest && typeof latest === 'object' ? latest : {};
  return {
    state: sameJson(safeBase.state, safeLocal.state) ? safeLatest.state : safeLocal.state,
    archive: mergeById(safeBase.archive, safeLocal.archive, safeLatest.archive, 'turnId'),
    longTermSummaries: mergeById(
      safeBase.longTermSummaries, safeLocal.longTermSummaries, safeLatest.longTermSummaries, 'id'
    ),
    recallLog: sameJson(safeBase.recallLog, safeLocal.recallLog) ? safeLatest.recallLog : safeLocal.recallLog
  };
}
