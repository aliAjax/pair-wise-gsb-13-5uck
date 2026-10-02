// 交接批次领域模型：批次关联油枪读数与支付流水，流水按「终端编号#流水号」标识。

export const TXN_FIELD_KEYS = ["amount", "method", "channel", "paymentRef", "nozzleId", "note"] as const;
export type TxnFieldKey = (typeof TXN_FIELD_KEYS)[number];

export const TXN_FIELD_LABELS: Record<TxnFieldKey, string> = {
  amount: "金额",
  method: "收款方式",
  channel: "支付渠道",
  paymentRef: "支付凭证号",
  nozzleId: "油枪号",
  note: "备注"
};

/** 字段级版本：每次修改 version+1，用于三方合并时判断「哪一侧改过」。 */
export interface FieldVersion {
  value: string | number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export type TxnFields = Record<TxnFieldKey, FieldVersion>;

/** 同字段双方都改过：保留两版，待站长处理。 */
export interface FieldConflict {
  field: TxnFieldKey;
  local: FieldVersion;
  remote: FieldVersion;
}

export interface PaymentTxn {
  key: string; // `${terminalId}#${seq}`，合并与去重的唯一键
  terminalId: string;
  seq: number;
  batchId: string;
  fields: TxnFields;
  /** 上次同步成功时的字段快照（三方合并的基线），null 表示从未同步。 */
  base: TxnFields | null;
  syncStatus: "pending" | "synced";
  conflict: FieldConflict[] | null;
  /** 同一笔支付（相同支付凭证号）只算一次，重复流水指向被保留的那条。 */
  duplicateOf: string | null;
  createdAt: string;
}

export interface NozzleReading {
  nozzleId: string;
  fuelType: string;
  price: number;
  opening: number;
  closing: number;
  updatedAt: string;
}

export type BatchStatus = "open" | "frozen";

export interface ShiftBatch {
  id: string;
  title: string;
  shift: string;
  terminalId: string;
  status: BatchStatus;
  legacy: boolean;
  nozzleReadings: NozzleReading[];
  createdAt: string;
  frozenAt: string | null;
  frozenBy: string | null;
  /** 复核冻结时的差额快照，冻结后不再变动。 */
  settledDiff: number | null;
  syncStatus: "pending" | "synced";
  syncError: string | null;
  note: string;
}

/** 结算差额：冻结批次落定后，新流水会使上次结果失效，需要重算。 */
export interface Settlement {
  carriedDiff: number;
  stale: boolean;
  computedAt: string | null;
}

/** 模拟远端（服务器）库：各终端重连后向这里合并。 */
export interface RemoteStore {
  txns: Record<string, PaymentTxn>;
  batches: Record<string, ShiftBatch>;
  terminals: Record<string, { lastSyncAt: string }>;
  meta: { migratedFromLegacy: boolean };
}

export interface LocalState {
  terminalId: string;
  seq: number;
  txns: PaymentTxn[];
  batches: ShiftBatch[];
  settlement: Settlement;
}

export const TERMINALS = ["T-01", "T-02", "T-03"] as const;
export const SHIFTS = ["早班", "中班", "晚班"] as const;
export const METHODS = ["现金", "电子支付"] as const;
export const CHANNELS = ["微信", "支付宝", "云闪付", "刷卡"] as const;
export const FUEL_TYPES = ["92#汽油", "95#汽油", "0#柴油"] as const;

export function nextShift(shift: string): string {
  const index = (SHIFTS as readonly string[]).indexOf(shift);
  return SHIFTS[(index + 1 + SHIFTS.length) % SHIFTS.length];
}

export function txnKey(terminalId: string, seq: number): string {
  return `${terminalId}#${String(seq).padStart(4, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
