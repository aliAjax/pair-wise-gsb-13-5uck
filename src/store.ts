import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import {
  FLOW_TYPE_LABEL,
  STORAGE_KEYS,
  TERMINAL_NAMES,
  flowKey,
} from "./meta";
import {
  batchTotals,
  computeCarry,
  createServerState,
  flowsOf,
  freezeBatch,
  resolveConflict as serverResolveConflict,
  resolveDuplicate as serverResolveDuplicate,
  uniqueId,
  upsertBatch,
  upsertFlow,
  type BatchTotals,
} from "./server";
import {
  loadServer,
  loadSetting,
  loadTerminalLocal,
  migrateLegacy,
  saveServer,
  saveSetting,
  saveTerminalLocal,
} from "./storage";
import type {
  AnyTerminalId,
  ClientBatch,
  EditableField,
  FlowDraft,
  FlowType,
  FlowValues,
  ServerBatch,
  ServerFlow,
  ServerState,
  ShiftType,
  TerminalId,
  TerminalLocal,
} from "./types";
import { TERMINAL_IDS } from "./types";

export interface Notice {
  id: number;
  kind: "ok" | "warn" | "error";
  text: string;
}

/** 页面展示用的流水行：服务端流水叠合本终端尚未同步的改动 */
export interface FlowRow {
  key: string;
  originTerminal: AnyTerminalId;
  seq: number;
  type: FlowType;
  batchId: string;
  status: ServerFlow["status"];
  values: FlowValues;
  serverValues?: FlowValues;
  conflicts: ServerFlow["conflicts"];
  duplicateOf?: string;
  lateForBatchId?: string;
  server?: ServerFlow;
  pending: boolean;
  pendingOnly: boolean;
  owner: boolean;
  updatedAt: string;
}

let noticeId = 0;

export const useStore = defineStore("handover", () => {
  // ---------- 初始化：服务端（共享权威态）+ 旧记录一次性升级 ----------
  const migrated = migrateLegacy();
  const server: ServerState = reactive(
    loadServer() ?? migrated ?? createServerState(new Date().toISOString())
  ) as ServerState;

  const online = ref(loadSetting<string>(STORAGE_KEYS.online, "1") === "1");
  const faultEnabled = ref(loadSetting<string>(STORAGE_KEYS.fault, "0") === "1");
  const currentTerminalId = ref<TerminalId>(
    ((): TerminalId => {
      const saved = localStorage.getItem(STORAGE_KEYS.currentTerminal) as TerminalId | null;
      return saved && (TERMINAL_IDS as readonly string[]).includes(saved)
        ? saved
        : TERMINAL_IDS[0];
    })()
  );

  const locals = reactive<Record<TerminalId, TerminalLocal>>(
    Object.fromEntries(
      TERMINAL_IDS.map((id) => [id, loadTerminalLocal(id)])
    ) as Record<TerminalId, TerminalLocal>
  );

  const notices = ref<Notice[]>([]);
  const syncing = ref(false);

  function notify(kind: Notice["kind"], text: string) {
    const id = ++noticeId;
    notices.value.push({ id, kind, text });
    window.setTimeout(() => {
      notices.value = notices.value.filter((n) => n.id !== id);
    }, 4200);
  }

  function persistServer() {
    saveServer(server);
  }
  function persistLocal() {
    saveTerminalLocal(locals[currentTerminalId.value]);
  }
  function persistAll() {
    persistServer();
    persistLocal();
  }

  // ---------- 终端与网络 ----------
  const local = computed<TerminalLocal>(() => locals[currentTerminalId.value]);

  function switchTerminal(id: TerminalId) {
    currentTerminalId.value = id;
    localStorage.setItem(STORAGE_KEYS.currentTerminal, id);
    notify("ok", `已切换到 ${TERMINAL_NAMES[id]}（${id}），各终端离线数据独立保存`);
  }

  function toggleOnline(value: boolean) {
    online.value = value;
    saveSetting("online", value ? "1" : "0");
    if (value) void sync(true);
    else notify("warn", "网络已断开，所有写入仅保存在本终端，恢复后按终端编号+流水号合并");
  }

  function toggleFault(value: boolean) {
    faultEnabled.value = value;
    saveSetting("fault", value ? "1" : "0");
    if (value) notify("warn", "已模拟网络故障：同步会随机中断，未完成项保留待重试");
  }

  // ---------- 同步队列（outbox） ----------
  const pendingCount = computed(
    () =>
      Object.keys(local.value.pendingBatches).length +
      Object.keys(local.value.pendingFlows).length
  );

  const pendingByTerminal = computed(() =>
    TERMINAL_IDS.map((id) => ({
      terminalId: id,
      batches: Object.keys(locals[id].pendingBatches).length,
      flows: Object.keys(locals[id].pendingFlows).length,
      lastSyncAt: locals[id].lastSyncAt,
    }))
  );

  function batchForClient(clientBatchId: string): { shift: ShiftType; businessDate: string } {
    const pb = local.value.pendingBatches[clientBatchId];
    if (pb) return { shift: pb.shift, businessDate: pb.businessDate };
    const sb = server.batches.find((b) => b.id === clientBatchId);
    if (sb) return { shift: sb.shift, businessDate: sb.businessDate };
    return { shift: "早班" as ShiftType, businessDate: new Date().toISOString().slice(0, 10) };
  }

  /**
   * 逐项提交 outbox：先批次后流水。开启网络故障模拟时每项约 45% 概率失败，
   * 一旦失败立即中断；已完成项从 outbox 移除，重试只补未完成项。
   */
  async function sync(silent = false): Promise<boolean> {
    if (!online.value || syncing.value) return false;
    syncing.value = true;
    let failed = false;
    try {
      const terminal = currentTerminalId.value;
      const store = locals[terminal];

      for (const clientId of Object.keys(store.pendingBatches)) {
        if (faultEnabled.value && Math.random() < 0.45) {
          failed = true;
          notify("error", `批次 ${clientId} 写入失败，已保留为待同步批次，稍后可重试`);
          break;
        }
        const pb = store.pendingBatches[clientId];
        const resolved = upsertBatch(server, {
          clientId,
          shift: pb.shift,
          businessDate: pb.businessDate,
          createdAt: pb.createdAt,
        });
        // 同班次同日批次合并：把临时批次下的待同步流水改派到正式批次
        if (resolved.id !== clientId) {
          for (const pf of Object.values(store.pendingFlows)) {
            if (pf.flow.batchId === clientId) pf.flow.batchId = resolved.id;
          }
        }
        delete store.pendingBatches[clientId];
        persistServer();
        saveTerminalLocal(store);
      }

      if (!failed) {
        for (const key of Object.keys(store.pendingFlows)) {
          if (faultEnabled.value && Math.random() < 0.45) {
            failed = true;
            notify("error", `流水 ${key} 写入失败，已保留，重试时补传未完成流水`);
            break;
          }
          const pf = store.pendingFlows[key];
          const meta = batchForClient(pf.flow.batchId);
          const result = upsertFlow(server, {
            key: pf.flow.key,
            originTerminal: pf.flow.originTerminal,
            seq: pf.flow.seq,
            type: pf.flow.type,
            values: pf.flow,
            batchClientId: pf.flow.batchId,
            batchShift: meta.shift,
            batchBusinessDate: meta.businessDate,
            baseVersion: pf.baseVersion,
            submittedAt: new Date().toISOString(),
          });

          // 迟到流水被改派到下一批次：本地待同步指向同步更新
          if (
            result.reroutedFromBatchId &&
            pf.flow.batchId === result.reroutedFromBatchId
          ) {
            pf.flow.batchId = result.flow.batchId;
          }
          delete store.pendingFlows[key];
          persistServer();
          saveTerminalLocal(store);

          if (result.duplicateWithKey) {
            notify(
              "warn",
              `流水 ${key} 与 ${result.duplicateWithKey} 凭证号相同，疑似同一笔支付重复录入，已挂起待站长处理`
            );
          }
        }
      }

      if (!failed) {
        store.lastSyncAt = new Date().toISOString();
        saveTerminalLocal(store);
      }
      persistServer();
      if (!silent && !failed) notify("ok", "同步完成：按终端编号+流水号合并，同一流水只计一次");
      if (failed) notify("warn", "同步中断，未完成批次/流水仍在待同步队列");
    } finally {
      syncing.value = false;
    }
    return !failed;
  }

  function autoSync() {
    if (online.value) void sync(true);
  }

  // ---------- 批次 ----------
  function createBatch(shift: ShiftType, businessDate: string): string {
    const store = local.value;
    const merge = Object.values(server.batches).find(
      (b) =>
        !b.legacy && b.status === "open" && b.shift === shift && b.businessDate === businessDate
    );
    const localMerge = Object.values(store.pendingBatches).find(
      (b) => b.shift === shift && b.businessDate === businessDate
    );
    if (merge) return merge.id;
    if (localMerge) return localMerge.id;

    const id = uniqueId("PB");
    const batch: ClientBatch = {
      id,
      shift,
      businessDate,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    store.pendingBatches[id] = batch;
    persistLocal();
    notify("ok", online.value ? "批次已创建，正在同步…" : "批次已离线保存在本终端，待重连同批次将自动合并");
    autoSync();
    return id;
  }

  /** 本终端可录入的开放批次（服务端 + 本终端待同步） */
  const openBatchChoices = computed(() => {
    const rows: {
      id: string;
      shift: ShiftType;
      businessDate: string;
      pending: boolean;
    }[] = [];
    for (const b of server.batches) {
      if (b.status === "open" && !b.legacy) {
        rows.push({ id: b.id, shift: b.shift, businessDate: b.businessDate, pending: false });
      }
    }
    for (const pb of Object.values(local.value.pendingBatches)) {
      if (!rows.some((r) => r.id === pb.id)) {
        rows.push({ id: pb.id, shift: pb.shift, businessDate: pb.businessDate, pending: true });
      }
    }
    rows.sort((a, b) =>
      b.businessDate.localeCompare(a.businessDate) || b.shift.localeCompare(a.shift)
    );
    return rows;
  });

  const openBatches = computed<ServerBatch[]>(() =>
    server.batches
      .filter((b) => b.status === "open")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
  const frozenBatches = computed<ServerBatch[]>(() =>
    server.batches
      .filter((b) => b.status === "frozen" && !b.legacy)
      .sort((a, b) => (b.frozenAt ?? "").localeCompare(a.frozenAt ?? ""))
  );
  const legacyBatches = computed<ServerBatch[]>(() =>
    server.batches.filter((b) => b.legacy).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  );

  /** 已在各终端离线创建、尚未同步成服务端批次的"影子批次" */
  const ghostBatches = computed<ClientBatch[]>(() => {
    const seen = new Set<string>();
    const rows: ClientBatch[] = [];
    for (const t of TERMINAL_IDS) {
      for (const pb of Object.values(locals[t].pendingBatches)) {
        if (seen.has(pb.id)) continue;
        seen.add(pb.id);
        rows.push(pb);
      }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  // ---------- 流水录入 / 编辑（离线优先） ----------
  function nextSeq(): number {
    const store = local.value;
    store.seq += 1;
    return store.seq;
  }

  function addFlow(draft: FlowDraft): string | undefined {
    const seq = nextSeq();
    const terminal = currentTerminalId.value;
    const now = new Date().toISOString();
    const key = flowKey(terminal, seq);
    const values: FlowValues = { ...draft.values };
    const flow = {
      key,
      originTerminal: terminal,
      seq,
      type: draft.type,
      batchId: draft.batchId,
      createdAt: now,
      updatedAt: now,
      ...values,
    };
    local.value.pendingFlows[key] = { flow, baseVersion: 0 };
    persistLocal();
    notify(
      "ok",
      online.value
        ? `流水 ${key} 已保存并同步`
        : `流水 ${key} 已离线保存（${TERMINAL_NAMES[terminal]} #${seq}）`
    );
    autoSync();
    return key;
  }

  function editFlow(key: string, values: FlowValues): { ok: boolean; reason?: string } {
    const store = local.value;
    const serverFlow = server.flows[key];

    if (store.pendingFlows[key]) {
      // 本终端尚未同步成功：直接改本地草稿，基线仍是 0
      Object.assign(store.pendingFlows[key].flow, values);
      store.pendingFlows[key].flow.updatedAt = new Date().toISOString();
      persistLocal();
      autoSync();
      return { ok: true };
    }

    if (!serverFlow) return { ok: false, reason: "流水不存在" };
    const batch = server.batches.find((b) => b.id === serverFlow.batchId);
    if (batch?.status === "frozen") {
      return { ok: false, reason: "批次已复核冻结，关联流水不能改动，新流水请录入下一批次" };
    }
    if (serverFlow.status === "void") return { ok: false, reason: "流水已作废" };

    const now = new Date().toISOString();
    const clientFlow = {
      key,
      originTerminal: serverFlow.originTerminal as TerminalId,
      seq: serverFlow.seq,
      type: serverFlow.type,
      batchId: serverFlow.batchId,
      createdAt: serverFlow.createdAt,
      updatedAt: now,
      ...values,
    };
    store.pendingFlows[key] = { flow: clientFlow, baseVersion: serverFlow.version };
    persistLocal();
    notify("ok", online.value ? "修改已提交，正在按三向合并同步…" : "修改已离线保存，恢复后与另一终端版本比对合并");
    autoSync();
    return { ok: true };
  }

  // ---------- 视图合成：服务端流水 + 各终端待同步草稿 ----------
  function pendingFlowsForBatch(batchId: string): FlowRow[] {
    const rows: FlowRow[] = [];
    for (const terminal of TERMINAL_IDS) {
      const store = locals[terminal];
      for (const pf of Object.values(store.pendingFlows)) {
        if (pf.flow.batchId !== batchId) continue;
        const sf = server.flows[pf.flow.key];
        if (sf) continue; // 已同步的以服务端行叠加展示
        rows.push({
          key: pf.flow.key,
          originTerminal: terminal,
          seq: pf.flow.seq,
          type: pf.flow.type,
          batchId,
          status: "active",
          values: { ...pf.flow },
          conflicts: [],
          pending: true,
          pendingOnly: true,
          owner: terminal === currentTerminalId.value,
          updatedAt: pf.flow.updatedAt,
        });
      }
    }
    return rows;
  }

  function rowsForBatch(batchId: string): FlowRow[] {
    const pendingByKey = new Map<string, { terminal: TerminalId; values: FlowValues; baseVersion: number; updatedAt: string }>();
    for (const terminal of TERMINAL_IDS) {
      for (const pf of Object.values(locals[terminal].pendingFlows)) {
        pendingByKey.set(pf.flow.key, {
          terminal,
          values: { ...pf.flow },
          baseVersion: pf.baseVersion,
          updatedAt: pf.flow.updatedAt,
        });
      }
    }

    const rows: FlowRow[] = flowsOf(server, batchId).map((sf) => {
      const pf = pendingByKey.get(sf.key);
      return {
        key: sf.key,
        originTerminal: sf.originTerminal,
        seq: sf.seq,
        type: sf.type,
        batchId: sf.batchId,
        status: sf.status,
        values: pf ? { ...pf.values } : { ...sf },
        serverValues: { ...sf },
        conflicts: sf.conflicts,
        duplicateOf: sf.duplicateOf,
        lateForBatchId: sf.lateForBatchId,
        server: sf,
        pending: !!pf,
        pendingOnly: false,
        owner: pf?.terminal === currentTerminalId.value,
        updatedAt: pf?.updatedAt ?? sf.updatedAt,
      };
    });
    rows.push(...pendingFlowsForBatch(batchId));

    rows.sort((a, b) =>
      a.originTerminal === b.originTerminal
        ? a.seq - b.seq
        : String(a.originTerminal).localeCompare(String(b.originTerminal))
    );
    return rows;
  }

  function flowByKey(key: string): ServerFlow | undefined {
    return server.flows[key];
  }

  function batchById(id: string): ServerBatch | ClientBatch | undefined {
    return server.batches.find((b) => b.id === id) ?? local.value.pendingBatches[id];
  }

  function totalsForBatch(batch: ServerBatch): BatchTotals {
    return batchTotals(server, batch.id);
  }

  /** 开放批次实时承接差额（迟到流水出现后重算） */
  function liveCarry(batch: ServerBatch): number {
    if (batch.status !== "open") return batch.carryDiff;
    return computeCarry(server, batch.businessDate, batch.shift);
  }

  // ---------- 待处理统计（冲突 / 重复） ----------
  const conflictCount = computed(
    () => Object.values(server.flows).filter((f) => f.status === "conflict").length
  );
  const duplicateCount = computed(
    () => Object.values(server.flows).filter((f) => f.status === "duplicate").length
  );

  function batchBlockers(batchId: string): string[] {
    const blockers: string[] = [];
    const rows = rowsForBatch(batchId);
    if (rows.some((r) => r.status === "conflict")) blockers.push("存在双方都改过的字段冲突");
    if (rows.some((r) => r.status === "duplicate")) blockers.push("存在疑似重复支付流水");
    if (rows.some((r) => r.pending)) blockers.push("还有终端流水未同步完成，复核后无法再改");
    return blockers;
  }

  // ---------- 站长操作 ----------
  function resolveConflicts(
    key: string,
    resolutions: { field: EditableField; value: string | number }[],
    reviewer: string
  ) {
    const updated = serverResolveConflict(
      server,
      key,
      resolutions,
      reviewer,
      new Date().toISOString()
    );
    if (updated) {
      // 站长已裁决：清掉各终端针对该流水的旧编辑，避免裁决被旧 base 的后到提交覆盖
      for (const t of TERMINAL_IDS) delete locals[t].pendingFlows[key];
      persistServer();
      for (const t of TERMINAL_IDS) saveTerminalLocal(locals[t]);
      notify("ok", `流水 ${key} 冲突已裁决，保留值：${resolutions.map((r) => r.value).join("、") || "空"}`);
    }
  }

  function resolveDuplicateFlow(key: string, action: "keep" | "void", reviewer: string) {
    const twinBefore = server.flows[key]?.duplicateOf;
    const updated = serverResolveDuplicate(server, key, action, reviewer, new Date().toISOString());
    if (updated) {
      const keys = new Set([key, twinBefore, updated.duplicateOf]);
      for (const t of TERMINAL_IDS) {
        for (const k of keys) {
          if (k) delete locals[t].pendingFlows[k];
        }
        saveTerminalLocal(locals[t]);
      }
      persistServer();
      notify(
        "ok",
        action === "keep"
          ? `已保留 ${key} 计收入账，另一笔作废，同一支付只计一次`
          : `流水 ${key} 已作废，另一笔恢复计收`
      );
    }
  }

  function reviewBatch(
    batchId: string,
    cashActual: number,
    digitalActual: number,
    reviewer: string,
    note: string
  ): { ok: boolean; reason?: string } {
    if (!online.value) return { ok: false, reason: "复核需要在线：请先恢复网络并完成同步" };
    const batch = server.batches.find((b) => b.id === batchId);
    if (!batch) return { ok: false, reason: "批次尚未同步到服务端" };
    if (batch.status !== "open") return { ok: false, reason: "批次已冻结" };
    const blockers = batchBlockers(batchId);
    if (blockers.length) return { ok: false, reason: blockers.join("；") };

    freezeBatch(
      server,
      batchId,
      cashActual,
      digitalActual,
      reviewer || "站长",
      note,
      new Date().toISOString()
    );
    persistServer();
    notify("ok", "批次已复核冻结：批次与关联流水全部锁定，新流水自动归入下一批次");
    return { ok: true };
  }

  /** 旧记录升级批次的简易复核（只查看用途） */
  function reviewLegacy(batchId: string) {
    const batch = server.batches.find((b) => b.id === batchId);
    if (!batch || !batch.legacy || batch.status !== "open") return;
    const now = new Date().toISOString();
    batch.status = "frozen";
    batch.frozenAt = now;
    batch.reviewNote = "旧记录升级后复核";
    batch.settlementDiff = 0;
    persistServer();
    notify("ok", "升级记录已标记为已复核（仅存档，不进入结算链）");
  }

  // ---------- 指标 ----------
  const metrics = computed(() => {
    const open = openBatches.value.length;
    const frozen = frozenBatches.value.length;
    const pending = TERMINAL_IDS.reduce(
      (sum, id) =>
        sum + Object.keys(locals[id].pendingBatches).length + Object.keys(locals[id].pendingFlows).length,
      0
    );
    const issues = conflictCount.value + duplicateCount.value;
    return { open, frozen, pending, issues };
  });

  const chartRows = computed(() => [
    { label: "开放批次", value: openBatches.value.length },
    { label: "已冻结", value: frozenBatches.value.length },
    { label: "字段冲突", value: conflictCount.value },
    { label: "重复挂起", value: duplicateCount.value },
  ]);

  function flowTypeLabel(t: FlowType): string {
    return FLOW_TYPE_LABEL[t];
  }

  return {
    // state
    server,
    online,
    faultEnabled,
    syncing,
    notices,
    currentTerminalId,
    locals,
    // terminal / network
    switchTerminal,
    toggleOnline,
    toggleFault,
    local,
    // sync
    sync,
    pendingCount,
    pendingByTerminal,
    // batches
    createBatch,
    openBatchChoices,
    openBatches,
    frozenBatches,
    legacyBatches,
    ghostBatches,
    batchById,
    // flows
    addFlow,
    editFlow,
    rowsForBatch,
    flowByKey,
    totalsForBatch,
    liveCarry,
    // review
    conflictCount,
    duplicateCount,
    batchBlockers,
    resolveConflicts,
    resolveDuplicateFlow,
    reviewBatch,
    reviewLegacy,
    // meta
    metrics,
    chartRows,
    flowTypeLabel,
    notify,
  };
});
