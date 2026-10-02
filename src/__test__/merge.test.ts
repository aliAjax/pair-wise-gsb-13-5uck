import {
  batchTotals,
  computeCarry,
  createServerState,
  flowsOf,
  freezeBatch,
  resolveConflict,
  resolveDuplicate,
  upsertBatch,
  upsertFlow,
} from "../server.ts";
import type { UpsertFlowInput } from "../server.ts";

let pass = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, extra ?? "");
    process.exit(1);
  }
  pass++;
  console.log("PASS:", name);
}

const now = () => new Date().toISOString();
const state = createServerState(now());

// 两终端各建同班次批次 -> 合并
const b1 = upsertBatch(state, { clientId: "PB-a", shift: "早班", businessDate: "2026-10-01", createdAt: now() });
const b2 = upsertBatch(state, { clientId: "PB-b", shift: "早班", businessDate: "2026-10-01", createdAt: now() });
check("同班次同日批次合并为一条", b1.id === b2.id);

// T01 现金 100（凭证 V1）；T02 断网时也录了同一凭证 V1
const mk = (
  origin: "T01" | "T02",
  seq: number,
  type: "cash" | "digital" | "nozzle",
  values: Record<string, unknown>,
  base = 0
): UpsertFlowInput => ({
  key: `${origin}:${seq}`,
  originTerminal: origin as never,
  seq,
  type,
  values,
  batchClientId: b1.id,
  batchShift: "早班",
  batchBusinessDate: "2026-10-01",
  baseVersion: base,
  submittedAt: now(),
});

const f1 = upsertFlow(state, mk("T01", 1, "cash", { amount: 100, voucher: "V1" }));
const f2 = upsertFlow(state, mk("T02", 1, "cash", { amount: 100, voucher: "V1" }));
check("重复支付两笔均挂起", f1.flow.status === "duplicate" && f2.flow.status === "duplicate");
check("重复挂起时合计为0", batchTotals(state, b1.id).expected === 0);

// 站长保留 T01 -> T01 active, T02 void，只计一次
resolveDuplicate(state, "T01:1", "keep", "站长", now());
check("裁决后保留笔 active", state.flows["T01:1"].status === "active");
check("裁决后另一笔 void", state.flows["T02:1"].status === "void");
check("同一支付只计一次 100", batchTotals(state, b1.id).expected === 100);

// 同终端重试提交同一 key（断网补传）-> 不新增
const retry = upsertFlow(state, mk("T01", 1, "cash", { amount: 100, voucher: "V1" }, 0));
check("同key补传是更新而非新增", Object.keys(state.flows).length === 2 && !retry.inserted);

// 三向合并：T01 先把金额改成 120（base v1），T02 离线时也改了同一笔为 130（同样 base v1）
upsertFlow(state, { ...mk("T01", 1, "cash", { amount: 120, voucher: "V1" }, 1) });
const verAfterT01 = state.flows["T01:1"].version;
check("单方修改直接收敛为120", state.flows["T01:1"].amount === 120);
// T02 编辑的是同一笔流水（key 仍是 T01:1），代表断网期间两名值班员各改各的
const conflictRes = upsertFlow(state, {
  ...mk("T01", 1, "cash", { amount: 130, voucher: "V1" }, 1),
  originTerminal: "T02" as never,
});
check("双方都改不同值产生冲突", conflictRes.flow.status === "conflict", conflictRes.flow.conflicts);
check("冲突保留两版 local=130 remote=120",
  conflictRes.flow.conflicts[0]?.field === "amount" &&
  conflictRes.flow.conflicts[0]?.local === 130 &&
  conflictRes.flow.conflicts[0]?.remote === 120);
check("冲突时金额不计入合计", batchTotals(state, b1.id).expected === 0);
void verAfterT01;

// 后到再来一次相同提交，不能覆盖/消解冲突
const again = upsertFlow(state, {
  ...mk("T01", 1, "cash", { amount: 130, voucher: "V1" }, 1),
  originTerminal: "T02" as never,
});
check("重复提交不会后到覆盖冲突", again.flow.conflicts.length === 1 && again.flow.status === "conflict");

// 站长裁决 125（裁决的是同一笔 T01:1）
resolveConflict(state, "T01:1", [{ field: "amount", value: 125 }], "站长", now());
check("裁决后恢复 active 且值125",
  state.flows["T01:1"].status === "active" && state.flows["T01:1"].amount === 125);
check("裁决后合计125", batchTotals(state, b1.id).expected === 125);

// 冻结批次：实收 120 -> 差额 = 0 + 125 - 120 = 5
freezeBatch(state, b1.id, 120, 0, "站长", "", now());
check("冻结结算差额=5", b1.settlementDiff === 5, b1.settlementDiff);

// 迟到流水：T01 又补了一笔归属该批次的现金 8（冻结后到达）
const late = upsertFlow(state, mk("T01", 2, "cash", { amount: 8, voucher: "V9" }));
check("迟到流水改派到下一批次", !!late.reroutedFromBatchId && late.flow.batchId !== b1.id, late);
check("原批次差额标记失效", b1.settlementInvalid === true);
const nextBatch = state.batches.find((x) => x.id === late.flow.batchId)!;
check("下一批 carryDiff = 5 + 8 = 13", nextBatch.carryDiff === 13, nextBatch.carryDiff);
check("computeCarry 对更新批次返回13", computeCarry(state, nextBatch.businessDate, nextBatch.shift) === 13);
check("历史结算记录含失效条目", state.history.some((h) => !h.valid && h.batchId === b1.id));

// 冻结流水不允许再改
const frozenEdit = upsertFlow(state, mk("T01", 1, "cash", { amount: 999, voucher: "V1" }, state.flows["T01:1"].version));
check("冻结后关联流水金额不能改", frozenEdit.flow.amount !== 999);

// 油枪读数升数
upsertFlow(state, {
  key: "T01:3", originTerminal: "T01" as never, seq: 3, type: "nozzle",
  values: { nozzleId: "1号枪", startReading: 100, endReading: 250 },
  batchClientId: nextBatch.id, batchShift: "早班", batchBusinessDate: nextBatch.businessDate,
  baseVersion: 0, submittedAt: now(),
});
check("油枪升数=150", batchTotals(state, nextBatch.id).liters === 150);
check("flowsOf 可读", flowsOf(state, nextBatch.id).length >= 2);

console.log(`\n全部 ${pass} 项通过`);
