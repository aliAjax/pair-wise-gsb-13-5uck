import { STORAGE_KEYS, flowKey } from "./meta";
import type {
  ServerBatch,
  ServerFlow,
  ServerState,
  TerminalId,
  TerminalLocal,
} from "./types";

/** 旧版页面保存的单条交接记录结构 */
interface LegacyRecord {
  id: string;
  shift?: string;
  fuelSales?: number | string;
  cash?: number | string;
  digital?: number | string;
  status?: string;
  notes?: string;
  createdAt?: string;
}

function readJSON<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时退化为内存态，页面功能仍可演示
  }
}

function businessDateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return iso.slice(0, 10);
}

/**
 * 将旧两条示例记录（以及旧格式 localStorage 中的用户记录）升级为
 * 冻结/开放批次 + 流水，保留原数值可查看。legacy 批次不参与结算链。
 */
export function migrateLegacy(): ServerState | undefined {
  if (localStorage.getItem(STORAGE_KEYS.migrated)) return undefined;
  localStorage.setItem(STORAGE_KEYS.migrated, "1");

  const raw = readJSON<LegacyRecord[]>(STORAGE_KEYS.legacy);
  const records = raw ?? [
    {
      id: "seed-1",
      shift: "早班",
      fuelSales: 4280,
      cash: 8300,
      digital: 21000,
      status: "已复核",
      notes: "账实一致",
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: "seed-2",
      shift: "中班",
      fuelSales: 3910,
      cash: 6400,
      digital: 19800,
      status: "待复核",
      notes: "等待站长确认",
      createdAt: new Date().toISOString(),
    },
  ];

  const state: ServerState = {
    version: 1,
    batches: [],
    flows: {},
    history: [],
    createdAt: new Date().toISOString(),
  };

  records.forEach((rec, index) => {
    const createdAt = rec.createdAt ?? new Date().toISOString();
    const shift = (["早班", "中班", "晚班"].includes(String(rec.shift))
      ? rec.shift
      : "早班") as ServerBatch["shift"];
    const batch: ServerBatch = {
      id: `legacy-${rec.id}`,
      shift,
      businessDate: businessDateOf(createdAt),
      status: rec.status === "已复核" ? "frozen" : "open",
      legacy: true,
      legacyFuelSales: Number(rec.fuelSales) || 0,
      legacyCash: Number(rec.cash) || 0,
      legacyDigital: Number(rec.digital) || 0,
      legacyNote: rec.notes || "",
      carryDiff: 0,
      createdAt,
      frozenAt: rec.status === "已复核" ? createdAt : undefined,
      reviewNote: rec.status === "已复核" ? "旧记录升级，账实一致" : undefined,
    };
    state.batches.push(batch);

    const t = "LEGACY" as const;
    const seqBase = index * 3;
    const mkFlow = (
      seq: number,
      type: ServerFlow["type"],
      values: Partial<ServerFlow>
    ): ServerFlow => ({
      key: flowKey(t, seqBase + seq + 1),
      originTerminal: t,
      seq: seqBase + seq + 1,
      type,
      batchId: batch.id,
      status: "active",
      version: 1,
      snapshots: { 1: { ...values } },
      conflicts: [],
      createdAt,
      updatedAt: createdAt,
      ...values,
    });

    const liters = batch.legacyFuelSales ?? 0;
    state.flows[flowKey("LEGACY", seqBase + 1)] = mkFlow(0, "nozzle", {
      nozzleId: "升级数据",
      startReading: 0,
      endReading: liters,
    });
    state.flows[flowKey("LEGACY", seqBase + 2)] = mkFlow(1, "cash", {
      amount: batch.legacyCash ?? 0,
      voucher: `旧记录-${index + 1}-现金`,
    });
    state.flows[flowKey("LEGACY", seqBase + 3)] = mkFlow(2, "digital", {
      amount: batch.legacyDigital ?? 0,
      method: "电子支付",
      voucher: `旧记录-${index + 1}-电子`,
    });
  });

  return state;
}

export function loadServer(): ServerState | undefined {
  return readJSON<ServerState>(STORAGE_KEYS.server);
}

export function saveServer(state: ServerState): void {
  writeJSON(STORAGE_KEYS.server, state);
}

export function loadTerminalLocal(id: TerminalId): TerminalLocal {
  const existing = readJSON<TerminalLocal>(STORAGE_KEYS.local(id));
  if (existing && existing.terminalId === id) return existing;
  return { terminalId: id, seq: 0, pendingBatches: {}, pendingFlows: {} };
}

export function saveTerminalLocal(local: TerminalLocal): void {
  writeJSON(STORAGE_KEYS.local(local.terminalId), local);
}

export function loadSetting<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : (raw as unknown as T);
}

export function saveSetting(key: string, value: unknown): void {
  localStorage.setItem(key, String(value));
}
