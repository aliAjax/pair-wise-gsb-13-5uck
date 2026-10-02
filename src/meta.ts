import {
  DIGITAL_METHODS,
  type EditableField,
  type FlowType,
  type ShiftType,
  TERMINAL_IDS,
} from "./types";

export const TERMINAL_NAMES: Record<string, string> = {
  T01: "1号收银终端",
  T02: "2号收银终端",
  T03: "3号移动终端",
};

export const SHIFT_OPTIONS: readonly ShiftType[] = ["早班", "中班", "晚班"];

export const FLOW_TYPE_OPTIONS: { value: FlowType; label: string }[] = [
  { value: "nozzle", label: "油枪读数" },
  { value: "cash", label: "现金流水" },
  { value: "digital", label: "电子支付流水" },
];

export const DIGITAL_OPTIONS = DIGITAL_METHODS;

export const TERMINAL_OPTIONS = TERMINAL_IDS;

export const FLOW_TYPE_LABEL: Record<FlowType, string> = {
  nozzle: "油枪读数",
  cash: "现金",
  digital: "电子支付",
};

export const DIGITAL_LABEL: Record<string, string> = Object.fromEntries(
  DIGITAL_METHODS.map((m) => [m, m])
);

export const FIELD_LABELS: Record<EditableField, string> = {
  nozzleId: "油枪编号",
  startReading: "起始读数",
  endReading: "结束读数",
  amount: "金额",
  method: "支付方式",
  voucher: "支付凭证号",
  note: "备注",
};

export const TYPE_FIELDS: Record<FlowType, EditableField[]> = {
  nozzle: ["nozzleId", "startReading", "endReading", "note"],
  cash: ["amount", "voucher", "note"],
  digital: ["amount", "method", "voucher", "note"],
};

export const NUMERIC_FIELDS: ReadonlySet<EditableField> = new Set([
  "startReading",
  "endReading",
  "amount",
]);

/** 油枪一读数对应升数（泵码），示例场景按 1:1 折算销量 */
export const NOZZLE_LITER_PER_READING = 1;

export const STORAGE_KEYS = {
  server: "dfwlfront-7-server-v2",
  currentTerminal: "dfwlfront-7-terminal",
  online: "dfwlfront-7-online",
  fault: "dfwlfront-7-fault",
  local: (id: string) => `dfwlfront-7-local-${id}`,
  legacy: "dfwlfront-7-shift",
  migrated: "dfwlfront-7-migrated-v2",
};

export function flowKey(terminal: string, seq: number): string {
  return `${terminal}:${seq}`;
}

export function formatMoney(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return `¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function formatLiters(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} L`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function dateLabel(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
