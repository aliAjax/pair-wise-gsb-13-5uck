/**
 * 端到端场景（不依赖 DOM，用内存 localStorage mock）：
 * 1) T01/T02 断网各自建批次、录流水
 * 2) T01 恢复网络：批次合并、同凭证重复挂起
 * 3) T02 恢复：编辑冲突保留两版
 * 4) 站长裁决、复核冻结
 * 5) 冻结后迟到流水归入下一批，差额失效重算
 */
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "../store";
import type { TerminalId } from "../types";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
(globalThis as Record<string, unknown>).localStorage = new MemoryStorage();
(globalThis as Record<string, unknown>).window = globalThis;

let pass = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, JSON.stringify(extra));
    process.exit(1);
  }
  pass++;
  console.log("PASS:", name);
}

setActivePinia(createPinia());
const store = useStore();

// 关闭故障随机，保证在线同步一次成功
store.toggleFault(false);
store.toggleOnline(false);

// T01：断网建早班批次、录油枪 + 现金 + 电子各一笔
store.switchTerminal("T01" as TerminalId);
const pb1 = store.createBatch("早班", "2026-10-02");
store.addFlow({
  type: "nozzle",
  batchId: pb1,
  values: { nozzleId: "1号枪", startReading: 0, endReading: 1200 },
});
store.addFlow({ type: "cash", batchId: pb1, values: { amount: 500, voucher: "C-1" } });
store.addFlow({
  type: "digital",
  batchId: pb1,
  values: { amount: 2000, method: "微信", voucher: "WX-77" },
});

// T02：同班次也建批次（临时批次不同）+ 同一笔微信支付（同凭证号）
store.switchTerminal("T02" as TerminalId);
const pb2 = store.createBatch("早班", "2026-10-02");
check("断网时两终端各有待同步批次", pb1 !== pb2);
store.addFlow({
  type: "digital",
  batchId: pb2,
  values: { amount: 2000, method: "微信", voucher: "WX-77" },
});
check(
  "断网录入不产生新的服务端流水",
  Object.values(store.server.flows).every((f) => f.originTerminal === "LEGACY")
);

// T01 恢复网络同步
store.switchTerminal("T01" as TerminalId);
store.toggleOnline(true);
const openAfterT01 = store.openBatches.filter((b) => !b.legacy);
check("T01同步后只有一个开放批次（待合批次暂未计入服务端）", openAfterT01.length === 1, openAfterT01.map((b) => b.id));
check("T01待同步清空", store.pendingCount === 0);

// T02 上线：临时批次合并到 T01 的批次；WX-77 检出重复
store.switchTerminal("T02" as TerminalId);
await store.sync(false);
check("T02待同步清空", store.pendingCount === 0);
const openBatches = store.openBatches.filter((b) => !b.legacy);
check("同班次批次合并为一条", openBatches.length === 1);
const batchId = openBatches[0].id;
const rows = store.rowsForBatch(batchId);
check("合并后共4笔流水（3+1）", rows.length === 4, rows.map((r) => r.key));
const dupRows = rows.filter((r) => r.status === "duplicate");
check("同凭证两笔均挂起为疑似重复", dupRows.length === 2, dupRows.map((r) => r.key));
const totals = store.totalsForBatch(openBatches[0]);
check("重复挂起时电子金额只计0（现金500）", totals.expected === 500, totals);
check("油枪升数1200", totals.liters === 1200);

// 站长保留 T01 的 WX 笔，T02 笔作废
store.resolveDuplicateFlow("T01:3", "keep", "站长");
const totals2 = store.totalsForBatch(openBatches[0]);
check("裁决后同一支付只计一次：2500", totals2.expected === 2500, totals2);

// 复核冻结
check("无阻塞项时可复核", store.batchBlockers(batchId).length === 0);
const review = store.reviewBatch(batchId, 500, 1980, "站长", "电子差20");
check("复核成功", review.ok, review.reason);
check("批次已冻结", openBatches[0].status === "frozen");
// 差额 = 0 + 2500 - 2480 = 20
check("结算差额20", openBatches[0].settlementDiff === 20, openBatches[0].settlementDiff);

// 冻结后 T02 断网又录了一笔原本属于该冻结批次的现金 100，重连后才上报
store.toggleOnline(false);
store.addFlow({ type: "cash", batchId, values: { amount: 100, voucher: "C-LATE" } });
store.toggleOnline(true);
const frozenBatch = store.server.batches.find((b) => b.id === batchId)!;
check("冻结批次差额已失效", frozenBatch.settlementInvalid === true);
const successor = store.server.batches.find((b) => b.id === frozenBatch.supersededByBatchId);
check("新批次承接差额=20+100=120", !!successor && successor.carryDiff === 120, successor?.carryDiff);

console.log(`\n端到端全部 ${pass} 项通过`);
