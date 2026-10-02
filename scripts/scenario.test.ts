// 场景验证：离线录入、合并去重、字段冲突、冻结、重试、迁移。
// 运行：node_modules/.bin/esbuild scripts/scenario.test.ts --bundle --format=esm --platform=node --outfile=/tmp/scenario.test.mjs && node /tmp/scenario.test.mjs

class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
}

(globalThis as any).localStorage = new MemStorage();
(globalThis as any).sessionStorage = new MemStorage();
(globalThis as any).window = { addEventListener() {} };

const { store } = await import("../src/shift/store");
const { loadRemote } = await import("../src/shift/storage");
const { batchTotals } = await import("../src/shift/merge");

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`✓ ${msg}`);
}

const s = store.state;

// ---------- 1. 旧记录迁移 ----------
assert(s.local.batches.length === 2, "迁移生成 2 个历史批次");
const legacyFrozen = s.local.batches.find((b) => b.title === "历史·早班");
const legacyOpen = s.local.batches.find((b) => b.title === "历史·中班");
assert(legacyFrozen?.status === "frozen" && legacyFrozen.legacy, "旧「已复核」记录 → 已冻结历史批次");
assert(legacyOpen?.status === "open" && legacyOpen.legacy, "旧「待复核」记录 → 开放历史批次");
const legacyTotals = batchTotals(legacyFrozen!, s.local.txns);
assert(legacyTotals.cash === 8300 && legacyTotals.digital === 21000, "历史批次金额可查看（现金8300/电子21000）");

// ---------- 2. 离线保存 + 同步 ----------
s.online = false;
store.addTxn({ method: "电子支付", channel: "微信", amount: 320, paymentRef: "WX001", nozzleId: "1号枪", note: "" });
assert(store.pendingCount.value === 1, "离线录入流水进入待同步");
store.syncNow();
assert(store.pendingCount.value === 1 && !!s.lastSyncError, "离线同步失败，待同步批次保留");
s.online = true;
store.syncNow();
assert(store.pendingCount.value === 0, "恢复在线后同步成功");
const txn1Key = s.local.txns.find((t) => t.fields.paymentRef.value === "WX001")!.key;
assert(txn1Key.startsWith("T-01#"), "流水键包含终端编号");

// ---------- 3. 同一笔支付只算一次（两名值班员各自录入） ----------
store.setTerminal("T-02");
store.addTxn({ method: "电子支付", channel: "微信", amount: 320, paymentRef: "WX001", nozzleId: "1号枪", note: "重复录入" });
store.syncNow();
store.setTerminal("T-01");
store.syncNow();
const wxGroup = s.local.txns.filter((t) => t.fields.paymentRef.value === "WX001");
assert(wxGroup.length === 2, "两个终端各录的一笔都保留");
assert(wxGroup.filter((t) => !t.duplicateOf).length === 1, "同一支付凭证号只算一次，其余剔除");
const openBatch = store.currentOpenBatch.value!;
const totalsAfterDup = batchTotals(openBatch, s.local.txns);
assert(totalsAfterDup.digital === 320, `剔除重复后电子支付合计=320（实际 ${totalsAfterDup.digital}）`);

// ---------- 4. 字段冲突：双方都改过，保留两版 ----------
s.online = false;
store.editTxn(txn1Key, { amount: 350 }); // T-01 离线改金额 320→350
store.setTerminal("T-02");
s.online = true;
store.editTxn(txn1Key, { amount: 999 }); // T-02 也改同一字段
store.syncNow(); // T-02 先同步
store.setTerminal("T-01");
s.online = true;
store.syncNow(); // T-01 后同步 → 冲突
const conflicted = s.local.txns.find((t) => t.key === txn1Key)!;
assert(!!conflicted.conflict && conflicted.conflict.length > 0, "同字段双方都改过 → 检出冲突");
const amountConflict = conflicted.conflict!.find((c) => c.field === "amount")!;
assert(amountConflict.local.value === 350 && amountConflict.remote.value === 999, "两版都保留（本端350/远端999），未按后到覆盖");
const totalsDuringConflict = batchTotals(openBatch, s.local.txns);
assert(totalsDuringConflict.digital === 0, "冲突流水未处理前不计入合计");

// ---------- 5. 站长处理冲突 ----------
store.resolveConflict(txn1Key, { amount: "local" });
assert(!s.local.txns.find((t) => t.key === txn1Key)!.conflict, "站长处理后冲突解除");
store.syncNow();
store.setTerminal("T-02");
store.syncNow();
const t2View = s.local.txns.find((t) => t.key === txn1Key)!;
assert(!t2View.conflict && t2View.fields.amount.value === 350, "处理结果同步到另一终端（金额=350）");
store.setTerminal("T-01");

// ---------- 6. 复核冻结 + 新流水入下一批次 + 差额失效重算 ----------
const openBatch2 = store.currentOpenBatch.value!; // 切终端后 state.local 已重建，重新获取
store.addReading(openBatch2.id, { nozzleId: "1号枪", fuelType: "92#汽油", price: 8, opening: 100, closing: 140 });
const t = batchTotals(openBatch2, s.local.txns);
assert(t.expected === 320, `油枪应收=(140-100)*8=320（实际 ${t.expected}）`);
const err = store.freezeBatch(openBatch2.id);
assert(err === null, "无冲突批次可复核冻结");
assert(openBatch2.status === "frozen", "批次已冻结");
const frozenTxn = s.local.txns.find((x) => x.key === txn1Key)!;
store.editTxn(txn1Key, { amount: 1 });
assert(frozenTxn.fields.amount.value === 350, "冻结后关联流水不可修改");
const nextBatch = store.currentOpenBatch.value!;
assert(nextBatch.id !== openBatch.id && nextBatch.status === "open", "自动开下一批次");
assert(s.local.settlement.stale, "上次结算差额已失效待重算");
store.addTxn({ method: "现金", channel: "", amount: 100, paymentRef: "", nozzleId: "", note: "" });
const newTxn = s.local.txns[s.local.txns.length - 1];
assert(newTxn.batchId === nextBatch.id, "新流水归入下一批次");
store.recomputeSettlement();
assert(!s.local.settlement.stale, "重算后差额恢复有效");
assert(s.local.settlement.carriedDiff === (350 + 0) - 320, `结算差额=冻结批次差额 30（实际 ${s.local.settlement.carriedDiff}）`);

// ---------- 7. 写入中断 + 重试补未完成流水 ----------
store.addTxn({ method: "现金", channel: "", amount: 50, paymentRef: "", nozzleId: "", note: "" });
store.addTxn({ method: "电子支付", channel: "支付宝", amount: 60, paymentRef: "ALI1", nozzleId: "", note: "" });
const pendingBefore = store.pendingCount.value;
assert(pendingBefore === 3, `当前 3 条待同步（实际 ${pendingBefore}）`);
s.simulateInterrupt = true;
store.syncNow();
assert(store.pendingCount.value === 2, `写入中断后剩余 2 条待同步（实际 ${store.pendingCount.value}）`);
assert(!!s.lastSyncError?.includes("写入中断"), "批次保留并标记同步失败");
store.syncNow();
assert(store.pendingCount.value === 0, "重试补完未完成流水");

// ---------- 8. 幂等：重复同步不产生重复流水 ----------
const remoteCountBefore = Object.keys(loadRemote().txns).length;
store.syncNow();
store.syncNow();
assert(Object.keys(loadRemote().txns).length === remoteCountBefore, "重复同步后远端流水数不变（幂等）");

// ---------- 9. 终端统计 ----------
const stats = store.terminalStats.value;
assert(stats.some((x) => x.id === "T-01" && x.pending === 0), "终端面板显示本终端待同步数");
assert(stats.some((x) => x.id === "T-02" && x.lastSyncAt !== null), "终端面板显示其他终端最近同步时间");

console.log(`\n全部 ${passed} 项断言通过`);
