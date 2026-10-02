// 合并引擎：重连后按「终端编号#流水号」合并，字段级三方对比，绝不按后到覆盖。

import type {
  FieldConflict,
  NozzleReading,
  PaymentTxn,
  ShiftBatch,
  TxnFields
} from "./types";
import { TXN_FIELD_KEYS } from "./types";

export function cloneFields(fields: TxnFields): TxnFields {
  return JSON.parse(JSON.stringify(fields)) as TxnFields;
}

function sameValue(a: string | number, b: string | number): boolean {
  return String(a) === String(b);
}

/**
 * 三方字段合并：以本地 base（上次同步快照）为基线。
 * - 只有一侧改过 → 取改过的一侧；
 * - 双方都改过且结果一致 → 取其一，不算冲突；
 * - 双方都改过且不一致 → 保留两版挂冲突，待站长处理，不按后到覆盖。
 */
export function mergeTxnFields(
  local: PaymentTxn,
  remote: PaymentTxn
): { fields: TxnFields; conflicts: FieldConflict[] } {
  const conflicts: FieldConflict[] = [];
  const merged = {} as TxnFields;
  for (const key of TXN_FIELD_KEYS) {
    const l = local.fields[key];
    const r = remote.fields[key];
    const b = local.base?.[key] ?? null;
    const localChanged = !b || l.version > b.version;
    const remoteChanged = !b || r.version > b.version;
    if (!localChanged && !remoteChanged) {
      merged[key] = r;
    } else if (localChanged && !remoteChanged) {
      merged[key] = l;
    } else if (!localChanged && remoteChanged) {
      merged[key] = r;
    } else if (sameValue(l.value, r.value)) {
      merged[key] = r.version >= l.version ? r : l;
    } else {
      conflicts.push({ field: key, local: l, remote: r });
      merged[key] = r; // 展示值以远端为准，两版都保留在 conflict 中等待站长处理
    }
  }
  return { fields: merged, conflicts };
}

/**
 * 合并同一 key 的本地与远端流水。
 * 冲突状态取舍：新检测到的冲突优先；否则本地有待推送改动时以本地为准（例如站长已在本端解决），
 * 否则采纳远端的冲突标记（其他终端检测到的冲突会同步过来）。
 */
export function mergeTxn(local: PaymentTxn, remote: PaymentTxn): PaymentTxn {
  const { fields, conflicts } = mergeTxnFields(local, remote);
  const conflict =
    conflicts.length > 0
      ? conflicts
      : local.syncStatus === "pending"
        ? local.conflict
        : (remote.conflict ?? local.conflict);
  return { ...local, fields, conflict };
}

/** 批次合并：冻结是单向的（任一侧冻结即冻结，取较早的冻结时间）；油枪读数按油枪号取并集。 */
export function mergeBatch(local: ShiftBatch, remote: ShiftBatch): ShiftBatch {
  const frozenSide = [local, remote]
    .filter((b) => b.status === "frozen")
    .sort((a, b) => (a.frozenAt ?? "").localeCompare(b.frozenAt ?? ""))[0];
  const base = frozenSide ?? local;
  const readings = new Map<string, NozzleReading>();
  for (const r of [...remote.nozzleReadings, ...local.nozzleReadings]) {
    const current = readings.get(r.nozzleId);
    if (!current || r.updatedAt >= current.updatedAt) readings.set(r.nozzleId, r);
  }
  return {
    ...base,
    nozzleReadings: [...readings.values()],
    syncStatus: local.syncStatus === "pending" || remote.syncStatus === "pending" ? "pending" : "synced",
    syncError: local.syncError
  };
}

/**
 * 同一笔支付只算一次：支付凭证号相同的流水视为同一笔，
 * 保留最早录入的一条，其余标记 duplicateOf 并从合计中剔除。
 */
export function applyDedup(txns: PaymentTxn[]): void {
  const byRef = new Map<string, PaymentTxn[]>();
  for (const txn of txns) {
    const ref = String(txn.fields.paymentRef.value).trim();
    if (!ref) {
      txn.duplicateOf = null;
      continue;
    }
    const group = byRef.get(ref) ?? [];
    group.push(txn);
    byRef.set(ref, group);
  }
  for (const group of byRef.values()) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    group.forEach((txn, index) => {
      txn.duplicateOf = index === 0 ? null : group[0].key;
    });
  }
}

export interface BatchTotals {
  cash: number;
  digital: number;
  expected: number | null;
  diff: number | null;
  activeCount: number;
  dupCount: number;
  conflictCount: number;
}

/** 批次合计：重复流水与待站长处理的冲突流水不计入金额。 */
export function batchTotals(batch: ShiftBatch, txns: PaymentTxn[]): BatchTotals {
  const own = txns.filter((t) => t.batchId === batch.id);
  const active = own.filter((t) => !t.duplicateOf && !(t.conflict && t.conflict.length > 0));
  const sum = (list: PaymentTxn[]) =>
    list.reduce((acc, t) => acc + (Number(t.fields.amount.value) || 0), 0);
  const cash = sum(active.filter((t) => t.fields.method.value === "现金"));
  const digital = sum(active.filter((t) => t.fields.method.value === "电子支付"));
  const priced = batch.nozzleReadings.filter((r) => r.price > 0);
  const expected =
    priced.length > 0
      ? priced.reduce((acc, r) => acc + (r.closing - r.opening) * r.price, 0)
      : null;
  return {
    cash,
    digital,
    expected,
    diff: expected === null ? null : cash + digital - expected,
    activeCount: active.length,
    dupCount: own.filter((t) => t.duplicateOf).length,
    conflictCount: own.filter((t) => t.conflict && t.conflict.length > 0).length
  };
}
