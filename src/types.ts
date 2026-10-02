export const TERMINAL_IDS = ["T01", "T02", "T03"] as const;
export type TerminalId = (typeof TERMINAL_IDS)[number];
/** LEGACY 仅用于旧两条示例记录升级后的只读流水 */
export type AnyTerminalId = TerminalId | "LEGACY";

export const SHIFTS = ["早班", "中班", "晚班"] as const;
export type ShiftType = (typeof SHIFTS)[number];

export type FlowType = "nozzle" | "cash" | "digital";

export const DIGITAL_METHODS = ["微信", "支付宝", "银联", "电子钱包"] as const;
export type DigitalMethod = (typeof DIGITAL_METHODS)[number];

/**
 * 流水可编辑字段。读数类用油枪编号/起止读数，收单类用金额/方式/凭证号。
 * 数值字段允许为空（录入中途），合并前统一归一化。
 */
export interface FlowValues {
  nozzleId?: string;
  startReading?: number;
  endReading?: number;
  amount?: number;
  method?: string;
  voucher?: string;
  note?: string;
}

export type EditableField = keyof FlowValues;

export interface FieldConflict {
  field: EditableField;
  /** 后到终端提交的版本 */
  local: string | number;
  /** 服务端已有的另一终端版本 */
  remote: string | number;
}

export type FlowStatus = "active" | "conflict" | "duplicate" | "void";

/**
 * 服务端流水。key = `${originTerminal}:${seq}`，同一 key 永远只有一条，
 * 重复同步走 upsert + 三向合并，不会插入第二条。
 */
export interface ServerFlow extends FlowValues {
  key: string;
  originTerminal: AnyTerminalId;
  seq: number;
  type: FlowType;
  batchId: string;
  status: FlowStatus;
  version: number;
  /** 每个版本保存一份字段快照，作为三向合并的 base */
  snapshots: Record<number, FlowValues>;
  conflicts: FieldConflict[];
  /** 重复支付凭证指向的另一笔流水 key */
  duplicateOf?: string;
  /** 原归属批次已冻结，本笔为迟到流水，记录原批次 */
  lateForBatchId?: string;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerBatch {
  id: string;
  shift: ShiftType;
  businessDate: string;
  status: "open" | "frozen";
  /** 旧两条示例记录升级而来的批次，只做查看/简单复核，不进入结算链 */
  legacy?: boolean;
  legacyFuelSales?: number;
  legacyCash?: number;
  legacyDigital?: number;
  legacyNote?: string;
  /** 从上一批次承接（或重算）的结算差额 */
  carryDiff: number;
  cashActual?: number;
  digitalActual?: number;
  /** 冻结时的结算差额 = carryDiff + 应收 - 实收 */
  settlementDiff?: number;
  /** 冻结后有迟到流水归入后续批次，本次差额已失效 */
  settlementInvalid?: boolean;
  supersededByBatchId?: string;
  reviewer?: string;
  reviewNote?: string;
  createdAt: string;
  frozenAt?: string;
}

export interface SettlementEntry {
  id: string;
  batchId: string;
  diff: number;
  valid: boolean;
  reason?: string;
  at: string;
}

export interface ServerState {
  version: number;
  batches: ServerBatch[];
  flows: Record<string, ServerFlow>;
  history: SettlementEntry[];
  createdAt: string;
}

/** 终端本地暂存的批次（同步前用临时 id） */
export interface ClientBatch {
  id: string;
  shift: ShiftType;
  businessDate: string;
  status: "open";
  createdAt: string;
}

export interface ClientFlow extends FlowValues {
  key: string;
  originTerminal: TerminalId;
  seq: number;
  type: FlowType;
  batchId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingFlow {
  flow: ClientFlow;
  /** 本次编辑所依据的服务端版本，新建流水为 0 */
  baseVersion: number;
}

export interface TerminalLocal {
  terminalId: TerminalId;
  /** 该终端自己分配的单调递增流水号 */
  seq: number;
  pendingBatches: Record<string, ClientBatch>;
  pendingFlows: Record<string, PendingFlow>;
  lastSyncAt?: string;
}

export interface FlowDraft {
  type: FlowType;
  batchId: string;
  values: FlowValues;
}
