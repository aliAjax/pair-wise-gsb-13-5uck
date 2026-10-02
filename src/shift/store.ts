// 响应式 store：各终端离线保存，重连后向远端合并；冲突保留两版；复核冻结与差额重算。

import { computed, reactive } from "vue";
import type {
  LocalState,
  NozzleReading,
  PaymentTxn,
  RemoteStore,
  ShiftBatch,
  TxnFieldKey
} from "./types";
import { nextShift, nowIso, txnKey } from "./types";
import type { BatchTotals } from "./merge";
import { applyDedup, batchTotals, cloneFields, mergeBatch, mergeTxn } from "./merge";
import { loadLocal, loadRemote, migrateLegacy, saveLocal, saveRemote } from "./storage";

const TERMINAL_SESSION_KEY = "dfwlfront-7-terminal";

interface StoreState {
  terminalId: string;
  online: boolean;
  simulateInterrupt: boolean;
  local: LocalState;
  remoteTerminals: Record<string, { lastSyncAt: string }>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  migrateNotice: string | null;
}

function adoptRemote(remote: RemoteStore, terminalId: string): LocalState {
  const txns = Object.values(remote.txns).map((rt) => ({
    ...rt,
    base: cloneFields(rt.fields),
    syncStatus: "synced" as const
  }));
  const seq = txns
    .filter((t) => t.terminalId === terminalId)
    .reduce((max, t) => Math.max(max, t.seq), 0);
  return {
    terminalId,
    seq,
    txns,
    batches: Object.values(remote.batches).map((b) => ({ ...b })),
    settlement: { carriedDiff: 0, stale: false, computedAt: null }
  };
}

function initLocal(terminalId: string, notice: (msg: string) => void): LocalState {
  const existing = loadLocal(terminalId);
  if (existing) return existing;
  const remote = loadRemote();
  if (!remote.meta.migratedFromLegacy) {
    const migrated = migrateLegacy();
    for (const b of migrated.batches) remote.batches[b.id] = b;
    for (const t of migrated.txns) remote.txns[t.key] = t;
    remote.meta.migratedFromLegacy = true;
    saveRemote(remote);
    notice(`已升级 ${migrated.batches.length} 条历史交接记录，可在批次列表查看`);
  }
  const local = adoptRemote(remote, terminalId);
  saveLocal(local);
  return local;
}

const state = reactive<StoreState>({
  terminalId: sessionStorage.getItem(TERMINAL_SESSION_KEY) ?? "T-01",
  online: true,
  simulateInterrupt: false,
  local: null as unknown as LocalState,
  remoteTerminals: {},
  lastSyncAt: null,
  lastSyncError: null,
  migrateNotice: null
});
state.local = initLocal(state.terminalId, (msg) => (state.migrateNotice = msg));
state.remoteTerminals = loadRemote().terminals;

function persist(): void {
  saveLocal(state.local);
}

/** 冻结批次存在时，任何影响金额的变动都让上次结算差额失效，等待重算。 */
function touchTotals(): void {
  if (state.local.batches.some((b) => b.status === "frozen")) {
    state.local.settlement.stale = true;
  }
}

function findBatch(id: string): ShiftBatch | undefined {
  return state.local.batches.find((b) => b.id === id);
}

function findTxn(key: string): PaymentTxn | undefined {
  return state.local.txns.find((t) => t.key === key);
}

function upsertTxn(txn: PaymentTxn): void {
  const index = state.local.txns.findIndex((t) => t.key === txn.key);
  if (index >= 0) state.local.txns.splice(index, 1, txn);
  else state.local.txns.push(txn);
}

function upsertBatch(batch: ShiftBatch): void {
  const index = state.local.batches.findIndex((b) => b.id === batch.id);
  if (index >= 0) state.local.batches.splice(index, 1, batch);
  else state.local.batches.push(batch);
}

function shiftStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 新流水归入当前开放批次；没有则自动开下一批次（历史批次不接收新流水）。 */
function ensureOpenBatch(): ShiftBatch {
  const open = state.local.batches
    .filter((b) => b.status === "open" && !b.legacy)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (open) return open;
  const last = [...state.local.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const shift = last ? nextShift(last.shift) : "早班";
  const batch: ShiftBatch = {
    id: crypto.randomUUID(),
    title: `${shift}·${shiftStamp()}`,
    shift,
    terminalId: state.terminalId,
    status: "open",
    legacy: false,
    nozzleReadings: [],
    createdAt: nowIso(),
    frozenAt: null,
    frozenBy: null,
    settledDiff: null,
    syncStatus: "pending",
    syncError: null,
    note: ""
  };
  state.local.batches.push(batch);
  return batch;
}

export interface TxnInput {
  method: string;
  channel: string;
  amount: number;
  paymentRef: string;
  nozzleId: string;
  note: string;
}

function addTxn(input: TxnInput): void {
  const batch = ensureOpenBatch();
  state.local.seq += 1;
  const at = nowIso();
  const by = state.terminalId;
  const field = (value: string | number) => ({ value, version: 1, updatedAt: at, updatedBy: by });
  const txn: PaymentTxn = {
    key: txnKey(state.terminalId, state.local.seq),
    terminalId: state.terminalId,
    seq: state.local.seq,
    batchId: batch.id,
    fields: {
      amount: field(input.amount),
      method: field(input.method),
      channel: field(input.method === "现金" ? "" : input.channel),
      paymentRef: field(input.paymentRef.trim()),
      nozzleId: field(input.nozzleId),
      note: field(input.note)
    },
    base: null,
    syncStatus: "pending",
    conflict: null,
    duplicateOf: null,
    createdAt: at
  };
  state.local.txns.push(txn);
  applyDedup(state.local.txns);
  touchTotals();
  persist();
}

function txnFrozen(txn: PaymentTxn): boolean {
  return findBatch(txn.batchId)?.status === "frozen";
}

/** 修改流水字段：版本号 +1 并标记待同步；已冻结批次的流水不可改。 */
function editTxn(key: string, patch: Partial<Record<TxnFieldKey, string | number>>): void {
  const txn = findTxn(key);
  if (!txn || txnFrozen(txn)) return;
  const at = nowIso();
  for (const [fieldKey, value] of Object.entries(patch) as [TxnFieldKey, string | number][]) {
    const current = txn.fields[fieldKey];
    txn.fields[fieldKey] = {
      value,
      version: current.version + 1,
      updatedAt: at,
      updatedBy: state.terminalId
    };
  }
  txn.syncStatus = "pending";
  applyDedup(state.local.txns);
  touchTotals();
  persist();
}

/** 站长处理冲突：逐字段选择保留本端或远端版本，解决后重新进入待同步。 */
function resolveConflict(key: string, choices: Record<string, "local" | "remote">): void {
  const txn = findTxn(key);
  if (!txn || !txn.conflict || txnFrozen(txn)) return;
  const at = nowIso();
  for (const c of txn.conflict) {
    const pick = choices[c.field] === "remote" ? c.remote : c.local;
    txn.fields[c.field] = {
      value: pick.value,
      version: Math.max(c.local.version, c.remote.version) + 1,
      updatedAt: at,
      updatedBy: `站长@${state.terminalId}`
    };
  }
  txn.conflict = null;
  txn.syncStatus = "pending";
  touchTotals();
  persist();
}

function addReading(batchId: string, reading: Omit<NozzleReading, "updatedAt">): void {
  const batch = findBatch(batchId);
  if (!batch || batch.status === "frozen") return;
  const index = batch.nozzleReadings.findIndex((r) => r.nozzleId === reading.nozzleId);
  const next = { ...reading, updatedAt: nowIso() };
  if (index >= 0) batch.nozzleReadings.splice(index, 1, next);
  else batch.nozzleReadings.push(next);
  batch.syncStatus = "pending";
  touchTotals();
  persist();
}

/** 站长复核：冻结批次与关联流水，新流水自动归入下一批次，上次结算差额失效待重算。 */
function freezeBatch(batchId: string): string | null {
  const batch = findBatch(batchId);
  if (!batch || batch.status === "frozen") return null;
  const totals = batchTotals(batch, state.local.txns);
  if (totals.conflictCount > 0) return "存在待站长处理的冲突，处理完成后才能复核冻结";
  batch.status = "frozen";
  batch.frozenAt = nowIso();
  batch.frozenBy = `站长@${state.terminalId}`;
  batch.settledDiff = totals.diff;
  batch.syncStatus = "pending";
  ensureOpenBatch(); // 后续流水归入下一批次
  state.local.settlement.stale = true;
  persist();
  return null;
}

/** 重算结算差额：汇总全部已冻结批次的落定差额。 */
function recomputeSettlement(): void {
  const carried = state.local.batches
    .filter((b) => b.status === "frozen")
    .reduce((acc, b) => acc + (b.settledDiff ?? batchTotals(b, state.local.txns).diff ?? 0), 0);
  state.local.settlement = { carriedDiff: carried, stale: false, computedAt: nowIso() };
  persist();
}

/** 拉取远端变更并入本地（本地待同步改动不受影响）。返回是否有变化。 */
function pullFrom(remote: RemoteStore): boolean {
  let changed = false;
  for (const rt of Object.values(remote.txns)) {
    const local = findTxn(rt.key);
    if (!local) {
      state.local.txns.push({ ...rt, base: cloneFields(rt.fields), syncStatus: "synced" });
      changed = true;
    } else if (local.syncStatus === "synced") {
      const merged = mergeTxn(local, rt);
      upsertTxn({ ...merged, syncStatus: "synced", base: cloneFields(merged.fields) });
      changed = true;
    }
  }
  for (const rb of Object.values(remote.batches)) {
    const local = findBatch(rb.id);
    if (!local) {
      state.local.batches.push({ ...rb });
      changed = true;
    } else {
      upsertBatch(mergeBatch(local, rb));
    }
  }
  return changed;
}

function refreshBatchFlags(error: string | null): void {
  for (const batch of state.local.batches) {
    const hasPendingTxn = state.local.txns.some((t) => t.batchId === batch.id && t.syncStatus === "pending");
    const pending = batch.syncStatus === "pending" || hasPendingTxn;
    batch.syncError = pending && error ? error : null;
  }
}

/**
 * 同步：把待同步流水逐条写入远端（按终端编号#流水号合并），再拉回其他终端的变更。
 * 写入中断时保留待同步批次，重试只补未完成的流水。
 */
function syncNow(): void {
  state.lastSyncError = null;
  if (!state.online) {
    state.lastSyncError = "当前离线：待同步批次已保留，恢复网络后请重试";
    refreshBatchFlags(state.lastSyncError);
    persist();
    return;
  }
  const remote = loadRemote();
  const pending = state.local.txns
    .filter((t) => t.syncStatus === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  let error: string | null = null;
  let pushed = 0;
  for (const txn of pending) {
    const remoteTxn = remote.txns[txn.key];
    const merged = remoteTxn ? mergeTxn(txn, remoteTxn) : { ...txn };
    merged.syncStatus = "synced";
    merged.base = cloneFields(merged.fields);
    remote.txns[txn.key] = merged;
    upsertTxn(merged);
    pushed += 1;
    if (state.simulateInterrupt && pushed < pending.length) {
      error = `写入中断：已写入 ${pushed}/${pending.length} 条流水，剩余待重试`;
      state.simulateInterrupt = false; // 一次性故障，重试即可补完
      break;
    }
  }
  if (!error) {
    for (const batch of state.local.batches) {
      const remoteBatch = remote.batches[batch.id];
      const merged = remoteBatch ? mergeBatch(batch, remoteBatch) : { ...batch };
      merged.syncStatus = "synced";
      merged.syncError = null;
      remote.batches[merged.id] = merged;
      upsertBatch(merged);
    }
    const changed = pullFrom(remote);
    if (changed) touchTotals();
    remote.terminals[state.terminalId] = { lastSyncAt: nowIso() };
    state.lastSyncAt = nowIso();
  }
  saveRemote(remote);
  applyDedup(state.local.txns);
  refreshBatchFlags(error);
  state.remoteTerminals = remote.terminals;
  state.lastSyncError = error;
  persist();
}

function setOnline(online: boolean): void {
  state.online = online;
}

function setTerminal(terminalId: string): void {
  if (terminalId === state.terminalId) return;
  sessionStorage.setItem(TERMINAL_SESSION_KEY, terminalId);
  state.terminalId = terminalId;
  state.local = initLocal(terminalId, (msg) => (state.migrateNotice = msg));
  // 切终端后立即拉取远端，保证看到的是最新合并视图
  const changed = pullFrom(loadRemote());
  if (changed) {
    applyDedup(state.local.txns);
    touchTotals();
    persist();
  }
  state.remoteTerminals = loadRemote().terminals;
  state.lastSyncAt = null;
  state.lastSyncError = null;
}

// 其他标签页（其他终端）写入远端后，本端实时拉取合并。
window.addEventListener("storage", (event) => {
  if (event.key !== null && !event.key.includes("remote")) return;
  const changed = pullFrom(loadRemote());
  if (changed) {
    applyDedup(state.local.txns);
    touchTotals();
    persist();
  }
  state.remoteTerminals = loadRemote().terminals;
});

// ---------- 视图计算 ----------

const batches = computed(() =>
  [...state.local.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

const currentOpenBatch = computed(
  () =>
    state.local.batches
      .filter((b) => b.status === "open" && !b.legacy)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
);

const totalsMap = computed(() => {
  const map = new Map<string, BatchTotals>();
  for (const batch of state.local.batches) map.set(batch.id, batchTotals(batch, state.local.txns));
  return map;
});

const txnsByBatch = computed(() => {
  const map = new Map<string, PaymentTxn[]>();
  for (const txn of state.local.txns) {
    const list = map.get(txn.batchId) ?? [];
    list.push(txn);
    map.set(txn.batchId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  }
  return map;
});

const pendingCount = computed(
  () => state.local.txns.filter((t) => t.syncStatus === "pending").length
);

const conflictTxns = computed(() =>
  state.local.txns.filter((t) => t.conflict && t.conflict.length > 0)
);

const terminalStats = computed(() => {
  const ids = new Set<string>([
    state.terminalId,
    ...Object.keys(state.remoteTerminals),
    ...state.local.txns.map((t) => t.terminalId)
  ]);
  return [...ids].sort().map((id) => ({
    id,
    current: id === state.terminalId,
    lastSyncAt: state.remoteTerminals[id]?.lastSyncAt ?? null,
    pending: id === state.terminalId ? pendingCount.value : null,
    conflicts: conflictTxns.value.filter((t) => t.terminalId === id).length,
    txnCount: state.local.txns.filter((t) => t.terminalId === id).length
  }));
});

const settlementView = computed(() => {
  const open = currentOpenBatch.value;
  const openDiff = open ? (totalsMap.value.get(open.id)?.diff ?? null) : null;
  return {
    ...state.local.settlement,
    openDiff,
    grand: state.local.settlement.carriedDiff + (openDiff ?? 0)
  };
});

export const store = {
  state,
  batches,
  currentOpenBatch,
  totalsMap,
  txnsByBatch,
  pendingCount,
  conflictTxns,
  terminalStats,
  settlementView,
  addTxn,
  editTxn,
  resolveConflict,
  addReading,
  freezeBatch,
  recomputeSettlement,
  syncNow,
  setOnline,
  setTerminal,
  txnFrozen,
  openBatch: ensureOpenBatch
};
