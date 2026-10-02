// 持久化：每终端独立本地库（离线保存），远端库模拟服务器；含旧版单表记录的升级迁移。

import type { LocalState, PaymentTxn, RemoteStore, ShiftBatch, TxnFields } from "./types";
import { nowIso, txnKey } from "./types";

const LEGACY_KEY = "dfwlfront-7-shift"; // 旧版单表记录（两条示例数据）
const REMOTE_KEY = "dfwlfront-7-remote-v1";
const LOCAL_PREFIX = "dfwlfront-7-local-v2:";

export function localKey(terminalId: string): string {
  return `${LOCAL_PREFIX}${terminalId}`;
}

export function loadLocal(terminalId: string): LocalState | null {
  const raw = localStorage.getItem(localKey(terminalId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalState;
  } catch {
    return null;
  }
}

export function saveLocal(state: LocalState): void {
  localStorage.setItem(localKey(state.terminalId), JSON.stringify(state));
}

export function emptyRemote(): RemoteStore {
  return { txns: {}, batches: {}, terminals: {}, meta: { migratedFromLegacy: false } };
}

export function loadRemote(): RemoteStore {
  const raw = localStorage.getItem(REMOTE_KEY);
  if (!raw) return emptyRemote();
  try {
    return { ...emptyRemote(), ...(JSON.parse(raw) as RemoteStore) };
  } catch {
    return emptyRemote();
  }
}

export function saveRemote(remote: RemoteStore): void {
  localStorage.setItem(REMOTE_KEY, JSON.stringify(remote));
}

interface LegacyRecord {
  shift: string;
  fuelSales: number;
  cash: number;
  digital: number;
  status: string;
  notes: string;
}

/** 旧版两条示例记录（无本地存储时的种子数据）。 */
const LEGACY_SEED: LegacyRecord[] = [
  { shift: "早班", fuelSales: 4280, cash: 8300, digital: 21000, status: "已复核", notes: "账实一致" },
  { shift: "中班", fuelSales: 3910, cash: 6400, digital: 19800, status: "待复核", notes: "等待站长确认" }
];

function readLegacyRecords(): LegacyRecord[] {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return LEGACY_SEED;
  try {
    const parsed = JSON.parse(raw) as LegacyRecord[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : LEGACY_SEED;
  } catch {
    return LEGACY_SEED;
  }
}

function legacyField(value: string | number, by: string, at: string) {
  return { value, version: 1, updatedAt: at, updatedBy: by };
}

function legacyTxn(
  seq: number,
  batchId: string,
  method: "现金" | "电子支付",
  amount: number,
  note: string,
  at: string
): PaymentTxn {
  const fields: TxnFields = {
    amount: legacyField(amount, "LEGACY", at),
    method: legacyField(method, "LEGACY", at),
    channel: legacyField(method === "现金" ? "" : "线上汇总", "LEGACY", at),
    paymentRef: legacyField("", "LEGACY", at),
    nozzleId: legacyField("", "LEGACY", at),
    note: legacyField(note, "LEGACY", at)
  };
  return {
    key: txnKey("LEGACY", seq),
    terminalId: "LEGACY",
    seq,
    batchId,
    fields,
    base: JSON.parse(JSON.stringify(fields)) as TxnFields,
    syncStatus: "synced",
    conflict: null,
    duplicateOf: null,
    createdAt: at
  };
}

/**
 * 旧版记录升级为交接批次：每条旧记录 → 一个历史批次（油枪汇总读数 + 现金/电子两条流水），
 * 原「已复核」映射为已冻结，其余保持开放待站长复核。迁移后旧记录仍可查看。
 */
export function migrateLegacy(): { batches: ShiftBatch[]; txns: PaymentTxn[] } {
  const records = readLegacyRecords();
  const batches: ShiftBatch[] = [];
  const txns: PaymentTxn[] = [];
  let seq = 0;
  records.forEach((record, index) => {
    const at = new Date(Date.now() - (records.length - index) * 86400000).toISOString();
    const batchId = `legacy-${index + 1}`;
    const reviewed = record.status === "已复核";
    batches.push({
      id: batchId,
      title: `历史·${record.shift}`,
      shift: record.shift,
      terminalId: "LEGACY",
      status: reviewed ? "frozen" : "open",
      legacy: true,
      nozzleReadings: [
        {
          nozzleId: "历史汇总",
          fuelType: "混合油品",
          price: 0,
          opening: 0,
          closing: Number(record.fuelSales) || 0,
          updatedAt: at
        }
      ],
      createdAt: at,
      frozenAt: reviewed ? at : null,
      frozenBy: reviewed ? "站长（历史复核）" : null,
      settledDiff: null,
      syncStatus: "synced",
      syncError: null,
      note: `${record.notes || "无备注"}${record.status === "有差异" ? "（原状态：有差异）" : ""}`
    });
    seq += 1;
    txns.push(legacyTxn(seq, batchId, "现金", Number(record.cash) || 0, "历史现金汇总", at));
    seq += 1;
    txns.push(legacyTxn(seq, batchId, "电子支付", Number(record.digital) || 0, "历史电子支付汇总", at));
  });
  return { batches, txns };
}
