import { NOZZLE_LITER_PER_READING, TYPE_FIELDS } from "./meta";
import type {
  EditableField,
  FieldConflict,
  FlowType,
  FlowValues,
  ServerBatch,
  ServerFlow,
  ServerState,
  ShiftType,
  TerminalId,
} from "./types";

export interface UpsertBatchInput {
  /** 终端暂存批次的临时 id；同班次同日批次重连后合并到同一服务端批次 */
  clientId: string;
  shift: ShiftType;
  businessDate: string;
  createdAt: string;
}

export interface UpsertFlowInput {
  key: string;
  originTerminal: TerminalId;
  seq: number;
  type: FlowType;
  values: FlowValues;
  /** 客户端提交时的目标批次（服务端临时 id 或正式 id） */
  batchClientId: string;
  batchShift: ShiftType;
  batchBusinessDate: string;
  baseVersion: number;
  submittedAt: string;
}

export interface UpsertFlowResult {
  flow: ServerFlow;
  inserted: boolean;
  /** 原批次已冻结，流水被改派到新批次 */
  reroutedFromBatchId?: string;
  /** 同凭证号的另一笔支付被检出重复 */
  duplicateWithKey?: string;
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function createServerState(now: string): ServerState {
  return {
    version: 1,
    batches: [],
    flows: {},
    history: [],
    createdAt: now,
  };
}

function normalizeForType(type: FlowType, values: FlowValues): FlowValues {
  const allowed = TYPE_FIELDS[type];
  const out: FlowValues = {};
  for (const field of allowed) {
    const v = values[field];
    if (v === undefined || v === "") continue;
    if (field === "startReading" || field === "endReading" || field === "amount") {
      const n = Number(v);
      if (!Number.isNaN(n)) out[field] = n;
    } else {
      out[field] = String(v);
    }
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === undefined || a === "") return b === undefined || b === "";
  return a === b;
}

/** 三向合并的字段值展示（空值显示为空串，便于两版对照） */
export function displayValue(v: unknown): string | number {
  if (v === undefined) return "";
  return v as string | number;
}

/** 按字符串键读写时使用的宽记录（FlowValues 各字段类型不同，直接索引会退化成 never） */
type WideValues = Record<string, string | number | undefined>;

function asWide(v: FlowValues): WideValues {
  return v as WideValues;
}

/**
 * 三向合并：以 base 版本为共同祖先，逐字段比对本地改动与服务端改动。
 * - 只有一方改过 → 采用改动值
 * - 双方改成相同值 → 直接收敛
 * - 双方都改且不同 → 记录两版冲突，绝不以后到覆盖
 * - 已存在未裁决的冲突继续保留，站长处理前不能自动消解
 */
function threeWayMerge(
  existing: ServerFlow,
  incoming: FlowValues,
  base: FlowValues
): { values: FlowValues; conflicts: FieldConflict[] } {
  const cur = asWide(pickFields(existing, TYPE_FIELDS[existing.type]));
  const inc = asWide(incoming);
  const bs = asWide(base);
  const conflicts = [...existing.conflicts];
  const result: WideValues = {};

  for (const field of TYPE_FIELDS[existing.type]) {
    const baseV = bs[field];
    const curV = cur[field];
    const newV = inc[field];
    const alreadyConflict = conflicts.some((c) => c.field === field);

    if (alreadyConflict) {
      result[field] = curV;
      continue;
    }
    const localChanged = !valuesEqual(newV, baseV);
    const remoteChanged = !valuesEqual(curV, baseV);

    if (localChanged && remoteChanged) {
      if (valuesEqual(newV, curV)) {
        result[field] = newV;
      } else {
        conflicts.push({
          field,
          local: displayValue(newV),
          remote: displayValue(curV),
        });
        result[field] = curV;
      }
    } else if (localChanged) {
      result[field] = newV;
    } else {
      result[field] = curV;
    }
  }

  // 已有未裁决冲突的字段保持两版并存，站长处理前不自动消解
  return { values: result as FlowValues, conflicts };
}

function pickFields(values: FlowValues, fields: readonly EditableField[]): FlowValues {
  const src = asWide(values);
  const out: WideValues = {};
  for (const f of fields) {
    const v = src[f];
    if (v !== undefined) out[f] = v;
  }
  return out as FlowValues;
}

/** 同班次同日开放批次的合并：不新建重复批次，返回已有批次 */
export function upsertBatch(state: ServerState, input: UpsertBatchInput): ServerBatch {
  const existing = state.batches.find(
    (b) =>
      !b.legacy &&
      b.status === "open" &&
      b.shift === input.shift &&
      b.businessDate === input.businessDate
  );
  if (existing) return existing;

  const carry = computeCarry(state, input.businessDate, input.shift);
  const batch: ServerBatch = {
    id: uniqueId("B"),
    shift: input.shift,
    businessDate: input.businessDate,
    status: "open",
    carryDiff: carry,
    createdAt: input.createdAt,
  };
  state.batches.push(batch);
  return batch;
}

function findOpenBatch(state: ServerState, shift: ShiftType, date: string): ServerBatch {
  const found = state.batches.find(
    (b) => !b.legacy && b.status === "open" && b.shift === shift && b.businessDate === date
  );
  if (found) return found;
  return upsertBatch(state, {
    clientId: uniqueId("auto"),
    shift,
    businessDate: date,
    createdAt: new Date().toISOString(),
  });
}

/** 查找同凭证号的另一笔有效支付流水（跨终端重复收款的关键检测） */
function findVoucherTwin(state: ServerState, flow: {
  type: FlowType;
  voucher?: string;
  key: string;
}): ServerFlow | undefined {
  const voucher = (flow.voucher ?? "").trim();
  if (!voucher || flow.type === "nozzle") return undefined;
  return Object.values(state.flows).find(
    (f) =>
      f.key !== flow.key &&
      f.type === flow.type &&
      f.status !== "void" &&
      (f.voucher ?? "").trim() === voucher
  );
}

export function upsertFlow(state: ServerState, input: UpsertFlowInput): UpsertFlowResult {
  const normalized = normalizeForType(input.type, input.values);
  const existing = state.flows[input.key];
  let reroutedFromBatchId: string | undefined;

  let targetBatch: ServerBatch;
  if (existing) {
    const currentBatch = state.batches.find((b) => b.id === existing.batchId);
    if (currentBatch && currentBatch.status === "frozen") {
      // 冻结批次的关联流水不能再改派回原批，保持原归属
      targetBatch = currentBatch;
    } else {
      // 跟随本次提交指向的批次（临时 id 需要解析）
      targetBatch =
        state.batches.find((b) => b.id === input.batchClientId) ??
        findOpenBatch(state, input.batchShift, input.batchBusinessDate);
    }
  } else {
    targetBatch =
      state.batches.find((b) => b.id === input.batchClientId) ??
      findOpenBatch(state, input.batchShift, input.batchBusinessDate);
    if (targetBatch.status === "frozen") {
      reroutedFromBatchId = targetBatch.id;
      targetBatch = findOpenBatch(state, input.batchShift, input.batchBusinessDate);
    }
  }

  if (!existing) {
    const flow: ServerFlow = {
      key: input.key,
      originTerminal: input.originTerminal,
      seq: input.seq,
      type: input.type,
      batchId: targetBatch.id,
      status: "active",
      version: 1,
      snapshots: { 0: {}, 1: normalized },
      conflicts: [],
      lateForBatchId: reroutedFromBatchId,
      createdAt: input.submittedAt,
      updatedAt: input.submittedAt,
      ...normalized,
    };
    state.flows[flow.key] = flow;
    invalidateForLateFlow(state, flow, input.submittedAt);

    const twin = findVoucherTwin(state, flow);
    if (twin) {
      flow.status = "duplicate";
      flow.duplicateOf = twin.key;
      twin.status = "duplicate";
      twin.duplicateOf = flow.key;
      twin.updatedAt = input.submittedAt;
      return { flow, inserted: true, reroutedFromBatchId, duplicateWithKey: twin.key };
    }
    return { flow, inserted: true, reroutedFromBatchId };
  }

  // 冻结/作废流水：复核后冻结，金额等字段不可再改
  const currentBatch = state.batches.find((b) => b.id === existing.batchId);
  if (currentBatch?.status === "frozen" || existing.status === "void") {
    return { flow: existing, inserted: false, reroutedFromBatchId };
  }

  const base = existing.snapshots[input.baseVersion] ?? existing.snapshots[0] ?? {};
  const { values, conflicts } = threeWayMerge(existing, normalized, base);

  const nextVersion = existing.version + 1;
  const nextStatus: ServerFlow["status"] =
    conflicts.length > 0
      ? "conflict"
      : existing.status === "conflict"
        ? "active"
        : existing.status === "duplicate"
          ? "duplicate"
          : existing.status;
  const updated: ServerFlow = {
    ...existing,
    ...values,
    batchId: targetBatch.id,
    conflicts,
    status: nextStatus,
    version: nextVersion,
    snapshots: { ...existing.snapshots, [nextVersion]: values },
    updatedAt: input.submittedAt,
  };
  state.flows[updated.key] = updated;

  const twin = findVoucherTwin(state, updated);
  if (twin && updated.status === "active") {
    updated.status = "duplicate";
    updated.duplicateOf = twin.key;
    twin.status = "duplicate";
    twin.duplicateOf = updated.key;
    twin.updatedAt = input.submittedAt;
    return { flow: updated, inserted: false, reroutedFromBatchId, duplicateWithKey: twin.key };
  }

  return { flow: updated, inserted: false, reroutedFromBatchId };
}

/**
 * 迟到流水归入新批次：原批次的结算差额标记失效（保留展示、加删除线），
 * 承接批次的 carryDiff 以「原批次差额 + 迟到流水金额」重算。
 */
function invalidateForLateFlow(state: ServerState, flow: ServerFlow, now: string): void {
  if (!flow.lateForBatchId) return;
  const frozen = state.batches.find((b) => b.id === flow.lateForBatchId);
  if (!frozen || frozen.status !== "frozen" || frozen.settlementDiff === undefined) return;

  if (!frozen.settlementInvalid) {
    frozen.settlementInvalid = true;
    frozen.supersededByBatchId = flow.batchId;
    const entry = [...state.history]
      .reverse()
      .find((h) => h.batchId === frozen.id && h.valid);
    if (entry) entry.valid = false;
    state.history.push({
      id: uniqueId("H"),
      batchId: frozen.id,
      diff: frozen.settlementDiff,
      valid: false,
      reason: `冻结后迟到流水 ${flow.key} 归入下一批次，差额失效重算`,
      at: now,
    });
  }
  recomputeCarryAfterLate(state, frozen);
}

/** 重新计算承接批次的 carryDiff */
function recomputeCarryAfterLate(state: ServerState, frozen: ServerBatch): void {
  const next = state.batches.find((b) => b.id === frozen.supersededByBatchId);
  if (!next || next.status !== "open") return;
  const lateSum = moneyFlowsOf(state, next.id).reduce(
    (sum, f) => (f.lateForBatchId === frozen.id ? sum + flowMoney(f) : sum),
    0
  );
  next.carryDiff = (frozen.settlementDiff ?? 0) + lateSum;
}

/**
 * 计算新开放批次承接的结算差额：沿最近一个有效冻结批次传递；
 * 若冻结批次已被迟到流水失效，则取其重算后的承接批次口径。
 */
export function computeCarry(state: ServerState, _date: string, _shift: ShiftType): number {
  const frozen = [...state.batches]
    .filter((b) => !b.legacy && b.status === "frozen" && b.settlementDiff !== undefined)
    .sort((a, b) => (b.frozenAt ?? "").localeCompare(a.frozenAt ?? ""))[0];
  if (!frozen) return 0;
  if (!frozen.settlementInvalid) return frozen.settlementDiff ?? 0;
  const successor = state.batches.find((b) => b.id === frozen.supersededByBatchId);
  return successor ? successor.carryDiff : frozen.settlementDiff ?? 0;
}

export function flowMoney(flow: ServerFlow): number {
  if (flow.type === "nozzle") return 0;
  return Number(flow.amount ?? 0);
}

export function flowLiters(flow: ServerFlow): number {
  if (flow.type !== "nozzle") return 0;
  const start = Number(flow.startReading ?? 0);
  const end = Number(flow.endReading ?? 0);
  return Math.max(0, end - start) * NOZZLE_LITER_PER_READING;
}

/** 可计入合计的流水：冲突未裁决、重复未处理、已作废都不计入 */
export function isCountable(flow: ServerFlow): boolean {
  return flow.status === "active";
}

export function moneyFlowsOf(state: ServerState, batchId: string): ServerFlow[] {
  return Object.values(state.flows).filter(
    (f) => f.batchId === batchId && f.type !== "nozzle"
  );
}

export function flowsOf(state: ServerState, batchId: string): ServerFlow[] {
  return Object.values(state.flows)
    .filter((f) => f.batchId === batchId)
    .sort((a, b) =>
      a.originTerminal === b.originTerminal
        ? a.seq - b.seq
        : String(a.originTerminal).localeCompare(String(b.originTerminal))
    );
}

export interface BatchTotals {
  liters: number;
  cash: number;
  digital: number;
  expected: number;
}

export function batchTotals(state: ServerState, batchId: string): BatchTotals {
  const flows = Object.values(state.flows).filter((f) => f.batchId === batchId);
  let liters = 0;
  let cash = 0;
  let digital = 0;
  for (const f of flows) {
    if (!isCountable(f)) continue;
    liters += flowLiters(f);
    if (f.type === "cash") cash += flowMoney(f);
    if (f.type === "digital") digital += flowMoney(f);
  }
  return { liters, cash, digital, expected: cash + digital };
}

/** 复核冻结：记录实收、结算差额，批次与关联流水全部冻结 */
export function freezeBatch(
  state: ServerState,
  batchId: string,
  cashActual: number,
  digitalActual: number,
  reviewer: string,
  note: string,
  now: string
): ServerBatch | undefined {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch || batch.status !== "open") return undefined;

  const totals = batchTotals(state, batchId);
  batch.status = "frozen";
  batch.cashActual = cashActual;
  batch.digitalActual = digitalActual;
  batch.reviewer = reviewer;
  batch.reviewNote = note;
  batch.frozenAt = now;
  batch.settlementInvalid = false;
  batch.settlementDiff =
    batch.carryDiff + totals.expected - (cashActual + digitalActual);

  state.history.push({
    id: uniqueId("H"),
    batchId: batch.id,
    diff: batch.settlementDiff,
    valid: true,
    at: now,
  });
  return batch;
}

/** 站长裁决字段冲突：选用 local/remote 或自定义值，流水恢复 active */
export function resolveConflict(
  state: ServerState,
  flowKeyId: string,
  resolutions: { field: EditableField; value: string | number }[],
  reviewer: string,
  now: string
): ServerFlow | undefined {
  const flow = state.flows[flowKeyId];
  if (!flow) return undefined;
  for (const r of resolutions) {
    if (r.value === "") {
      delete flow[r.field];
    } else {
      flow[r.field] = r.value as never;
    }
  }
  flow.conflicts = flow.conflicts.filter(
    (c) => !resolutions.some((r) => r.field === c.field)
  );
  flow.status = flow.conflicts.length > 0 ? "conflict" : "active";
  flow.resolvedBy = reviewer;
  flow.version += 1;
  flow.snapshots[flow.version] = pickFields(flow, TYPE_FIELDS[flow.type]);
  flow.updatedAt = now;
  return flow;
}

/** 站长处理重复支付：保留计收入账，或作废（两笔都只计一次/都不计） */
export function resolveDuplicate(
  state: ServerState,
  flowKeyId: string,
  action: "keep" | "void",
  reviewer: string,
  now: string
): ServerFlow | undefined {
  const flow = state.flows[flowKeyId];
  if (!flow) return undefined;
  const twin = flow.duplicateOf ? state.flows[flow.duplicateOf] : undefined;

  if (action === "keep") {
    flow.status = "active";
    flow.duplicateOf = undefined;
    if (twin) {
      twin.status = "void";
      twin.duplicateOf = undefined;
      twin.updatedAt = now;
    }
  } else {
    flow.status = "void";
    flow.duplicateOf = undefined;
    if (twin) {
      twin.status = "active";
      twin.duplicateOf = undefined;
      twin.updatedAt = now;
    }
  }
  flow.resolvedBy = reviewer;
  flow.version += 1;
  flow.snapshots[flow.version] = pickFields(flow, TYPE_FIELDS[flow.type]);
  flow.updatedAt = now;
  return flow;
}
