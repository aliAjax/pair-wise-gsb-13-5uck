<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { store } from "./shift/store";
import type { PaymentTxn, ShiftBatch } from "./shift/types";
import { CHANNELS, FUEL_TYPES, METHODS, TERMINALS, TXN_FIELD_LABELS } from "./shift/types";

const { state } = store;

const project = {
  title: "加油站班次交接",
  subtitle: "交接批次关联油枪读数、现金与电子支付流水；各终端离线保存，重连后按终端编号和流水号合并，同一流水只算一次，字段冲突保留两版待站长处理。",
  stack: ["Vue3", "Vite", "TypeScript", "离线优先", "字段级合并"]
};

// ---------- 表单状态 ----------
const txnForm = reactive({
  method: "电子支付" as string,
  channel: CHANNELS[0] as string,
  amount: 0,
  paymentRef: "",
  nozzleId: "",
  note: ""
});

const readingForm = reactive({
  nozzleId: "",
  fuelType: FUEL_TYPES[0] as string,
  price: 7.85,
  opening: 0,
  closing: 0
});

const filter = ref("全部批次");
const filters = ["全部批次", "开放中", "已冻结", "有冲突", "历史记录"];
const actionError = ref("");
const editingKey = ref<string | null>(null);
const editModel = reactive({ amount: 0, paymentRef: "", nozzleId: "", note: "", channel: "" });
const choices = reactive<Record<string, Record<string, "local" | "remote">>>({});

// ---------- 视图计算 ----------
const filteredBatches = computed(() => {
  const list = store.batches.value;
  switch (filter.value) {
    case "开放中":
      return list.filter((b) => b.status === "open");
    case "已冻结":
      return list.filter((b) => b.status === "frozen");
    case "有冲突":
      return list.filter((b) => (store.totalsMap.value.get(b.id)?.conflictCount ?? 0) > 0);
    case "历史记录":
      return list.filter((b) => b.legacy);
    default:
      return list;
  }
});

const chartRows = computed(() =>
  store.batches.value
    .map((b) => ({ title: b.title, diff: store.totalsMap.value.get(b.id)?.diff ?? null }))
    .filter((row) => row.diff !== null)
    .reverse()
);
const maxAbsDiff = computed(() =>
  Math.max(1, ...chartRows.value.map((row) => Math.abs(row.diff ?? 0)))
);

function totalsOf(batch: ShiftBatch) {
  return store.totalsMap.value.get(batch.id);
}

function txnsOf(batch: ShiftBatch): PaymentTxn[] {
  return store.txnsByBatch.value.get(batch.id) ?? [];
}

function pendingOf(batch: ShiftBatch): number {
  return txnsOf(batch).filter((t) => t.syncStatus === "pending").length;
}

// ---------- 格式化 ----------
const fmtMoney = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
const fmtDiff = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "从未";

function txnSummary(txn: PaymentTxn): string {
  const f = txn.fields;
  const channel = f.channel.value ? `/${f.channel.value}` : "";
  return `${f.method.value}${channel} · ${fmtMoney(Number(f.amount.value))}`;
}

// ---------- 交互 ----------
function submitTxn() {
  if (!txnForm.amount || txnForm.amount <= 0) return;
  store.addTxn({ ...txnForm });
  txnForm.amount = 0;
  txnForm.paymentRef = "";
  txnForm.nozzleId = "";
  txnForm.note = "";
}

function submitReading() {
  if (!readingForm.nozzleId) return;
  const batch = store.openBatch();
  store.addReading(batch.id, { ...readingForm });
  readingForm.opening = readingForm.closing;
  readingForm.nozzleId = "";
}

function startEdit(txn: PaymentTxn) {
  editingKey.value = txn.key;
  editModel.amount = Number(txn.fields.amount.value) || 0;
  editModel.paymentRef = String(txn.fields.paymentRef.value);
  editModel.nozzleId = String(txn.fields.nozzleId.value);
  editModel.note = String(txn.fields.note.value);
  editModel.channel = String(txn.fields.channel.value);
}

function saveEdit() {
  if (!editingKey.value) return;
  store.editTxn(editingKey.value, { ...editModel });
  editingKey.value = null;
}

function choiceFor(txnKey: string, field: string): "local" | "remote" {
  return choices[txnKey]?.[field] ?? "local";
}

function setChoice(txnKey: string, field: string, side: "local" | "remote") {
  if (!choices[txnKey]) choices[txnKey] = {};
  choices[txnKey][field] = side;
}

function submitResolution(txn: PaymentTxn) {
  store.resolveConflict(txn.key, choices[txn.key] ?? {});
}

function freeze(batch: ShiftBatch) {
  const error = store.freezeBatch(batch.id);
  actionError.value = error ?? "";
}

function onTerminalChange(event: Event) {
  store.setTerminal((event.target as HTMLSelectElement).value);
}

function onOfflineToggle(event: Event) {
  store.setOnline(!(event.target as HTMLInputElement).checked);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 离线优先交接</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="top-actions">
          <label class="inline-field">
            本机终端
            <select :value="state.terminalId" @change="onTerminalChange">
              <option v-for="t in TERMINALS" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label class="switch">
            <input type="checkbox" :checked="!state.online" @change="onOfflineToggle" />
            离线模式
          </label>
          <button type="button" @click="store.syncNow">
            立即同步{{ store.pendingCount.value > 0 ? `（待同步 ${store.pendingCount.value}）` : "" }}
          </button>
        </div>
      </header>

      <p v-if="state.migrateNotice" class="notice">
        {{ state.migrateNotice }}
        <button class="secondary" type="button" @click="state.migrateNotice = null">知道了</button>
      </p>
      <p v-if="state.lastSyncError" class="notice error">
        {{ state.lastSyncError }}
        <button type="button" @click="store.syncNow">重试</button>
      </p>

      <section class="metrics">
        <article class="metric">
          <span>交接批次</span>
          <strong>{{ store.batches.value.length }}</strong>
        </article>
        <article class="metric">
          <span>待同步流水（本终端）</span>
          <strong>{{ store.pendingCount.value }}</strong>
        </article>
        <article class="metric">
          <span>待站长处理冲突</span>
          <strong :class="{ 'num-danger': store.conflictTxns.value.length > 0 }">
            {{ store.conflictTxns.value.length }}
          </strong>
        </article>
        <article class="metric">
          <span>
            结算差额
            <em v-if="store.settlementView.value.stale" class="stale-badge">已失效·待重算</em>
          </span>
          <strong>{{ fmtDiff(store.settlementView.value.carriedDiff) }}</strong>
        </article>
      </section>

      <section class="terminal-strip">
        <article v-for="t in store.terminalStats.value" :key="t.id" class="term-card" :class="{ current: t.current }">
          <p class="term-head">
            <strong>{{ t.id }}</strong>
            <span v-if="t.current" class="tag">本终端</span>
          </p>
          <p>最近同步：{{ fmtTime(t.lastSyncAt) }}</p>
          <p>待同步：{{ t.pending === null ? "—（对端离线不可见）" : t.pending }}</p>
          <p>待处理冲突：{{ t.conflicts }} · 流水 {{ t.txnCount }} 条</p>
        </article>
      </section>

      <section class="workspace">
        <div class="left-col">
          <form class="panel" @submit.prevent="submitTxn">
            <h2>录入支付流水</h2>
            <p class="hint">
              归入当前批次：{{ store.currentOpenBatch.value?.title ?? "提交时自动开新批次" }}
              <template v-if="!state.online">（离线保存，恢复后同步）</template>
            </p>
            <div class="form-grid">
              <label>
                收款方式
                <select v-model="txnForm.method">
                  <option v-for="m in METHODS" :key="m">{{ m }}</option>
                </select>
              </label>
              <label v-if="txnForm.method === '电子支付'">
                支付渠道
                <select v-model="txnForm.channel">
                  <option v-for="c in CHANNELS" :key="c">{{ c }}</option>
                </select>
              </label>
              <label>
                金额
                <input v-model.number="txnForm.amount" type="number" min="0" step="0.01" required />
              </label>
              <label>
                支付凭证号（同号去重）
                <input v-model="txnForm.paymentRef" placeholder="如 WX20261002001，可留空" />
              </label>
              <label>
                油枪号
                <input v-model="txnForm.nozzleId" placeholder="如 3号枪" />
              </label>
              <label>
                备注
                <input v-model="txnForm.note" placeholder="选填" />
              </label>
              <button type="submit">保存流水（{{ state.terminalId }}）</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitReading">
            <h2>登记油枪读数</h2>
            <p class="hint">写入当前开放批次，批次冻结后只读。</p>
            <div class="form-grid">
              <label>
                油枪号
                <input v-model="readingForm.nozzleId" placeholder="如 1号枪" required />
              </label>
              <label>
                油品
                <select v-model="readingForm.fuelType">
                  <option v-for="f in FUEL_TYPES" :key="f">{{ f }}</option>
                </select>
              </label>
              <label>
                单价（元/L）
                <input v-model.number="readingForm.price" type="number" min="0" step="0.01" required />
              </label>
              <label>
                开班读数
                <input v-model.number="readingForm.opening" type="number" min="0" step="0.01" required />
              </label>
              <label>
                收班读数
                <input v-model.number="readingForm.closing" type="number" min="0" step="0.01" required />
              </label>
              <button type="submit">保存读数</button>
            </div>
          </form>

          <section class="panel">
            <h2>结算差额</h2>
            <div class="settle-grid">
              <p>
                上次结算差额
                <strong>{{ fmtDiff(store.settlementView.value.carriedDiff) }}</strong>
                <em v-if="store.settlementView.value.stale" class="stale-badge">已失效·待重算</em>
              </p>
              <p>
                当前批次差额
                <strong>{{ fmtDiff(store.settlementView.value.openDiff) }}</strong>
              </p>
              <p>
                累计差额
                <strong>{{ fmtDiff(store.settlementView.value.grand) }}</strong>
              </p>
            </div>
            <button class="secondary" type="button" :disabled="!store.settlementView.value.stale" @click="store.recomputeSettlement">
              重算结算差额
            </button>
            <p class="hint">复核冻结后新流水归入下一批次，上次结算差额自动失效，需重算确认。</p>
          </section>

          <section class="panel">
            <h2>联调模拟</h2>
            <label class="switch">
              <input v-model="state.simulateInterrupt" type="checkbox" />
              模拟写入中断（下次同步只写入 1 条后失败，用于验证重试补录）
            </label>
            <p class="hint">开两个浏览器标签页选择不同终端，可模拟两名值班员同时离线录入。</p>
          </section>
        </div>

        <section class="list-panel">
          <div class="toolbar">
            <h2>交接批次</h2>
            <select v-model="filter">
              <option v-for="f in filters" :key="f">{{ f }}</option>
            </select>
          </div>
          <p v-if="actionError" class="notice error">{{ actionError }}</p>

          <div class="record-grid">
            <div v-if="filteredBatches.length === 0" class="empty">暂无匹配批次</div>
            <article v-for="batch in filteredBatches" :key="batch.id" class="record">
              <div class="record-head">
                <div>
                  <p class="record-title">
                    {{ batch.title }}
                    <span v-if="batch.legacy" class="tag">历史</span>
                  </p>
                  <p class="batch-meta">
                    创建终端 {{ batch.terminalId }} · {{ fmtTime(batch.createdAt) }}
                    <template v-if="batch.status === 'frozen'">
                      · 复核 {{ batch.frozenBy }} · {{ fmtTime(batch.frozenAt) }}
                    </template>
                  </p>
                </div>
                <div class="badges">
                  <span class="status" :class="{ frozen: batch.status === 'frozen' }">
                    {{ batch.status === "frozen" ? "已冻结" : "开放中" }}
                  </span>
                  <span v-if="pendingOf(batch) > 0 || batch.syncStatus === 'pending'" class="badge warn">
                    待同步
                  </span>
                  <span v-if="(totalsOf(batch)?.conflictCount ?? 0) > 0" class="badge danger">
                    冲突 {{ totalsOf(batch)?.conflictCount }}
                  </span>
                  <span v-if="batch.syncError" class="badge danger">同步失败</span>
                </div>
              </div>

              <p v-if="batch.syncError" class="sync-error">
                {{ batch.syncError }}
                <button type="button" @click="store.syncNow">重试（补未完成流水）</button>
              </p>
              <p v-if="batch.note" class="note">{{ batch.note }}</p>

              <table v-if="batch.nozzleReadings.length > 0" class="readings-table">
                <thead>
                  <tr>
                    <th>油枪</th><th>油品</th><th>单价</th><th>开班</th><th>收班</th><th>销量L</th><th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in batch.nozzleReadings" :key="r.nozzleId">
                    <td>{{ r.nozzleId }}</td>
                    <td>{{ r.fuelType }}</td>
                    <td>{{ r.price > 0 ? r.price : "—" }}</td>
                    <td>{{ r.opening }}</td>
                    <td>{{ r.closing }}</td>
                    <td>{{ r.closing - r.opening }}</td>
                    <td>{{ r.price > 0 ? fmtMoney((r.closing - r.opening) * r.price) : "—" }}</td>
                  </tr>
                </tbody>
              </table>

              <div class="txn-list">
                <div v-for="txn in txnsOf(batch)" :key="txn.key" class="txn-row" :class="{ dimmed: !!txn.duplicateOf }">
                  <template v-if="editingKey !== txn.key">
                    <div class="txn-main">
                      <span class="txn-key">{{ txn.key }}</span>
                      <span>{{ txnSummary(txn) }}</span>
                      <span v-if="txn.fields.paymentRef.value" class="txn-ref">凭证 {{ txn.fields.paymentRef.value }}</span>
                      <span v-if="txn.fields.nozzleId.value" class="txn-ref">{{ txn.fields.nozzleId.value }}</span>
                    </div>
                    <div class="txn-side">
                      <span v-if="txn.syncStatus === 'pending'" class="badge warn">待同步</span>
                      <span v-else class="badge ok">已同步</span>
                      <span v-if="txn.conflict" class="badge danger">冲突待处理</span>
                      <span v-if="txn.duplicateOf" class="badge muted">重复·已剔除（同 {{ txn.duplicateOf }}）</span>
                      <button
                        v-if="batch.status === 'open'"
                        class="secondary"
                        type="button"
                        @click="startEdit(txn)"
                      >修改</button>
                    </div>
                  </template>

                  <div v-else class="inline-edit">
                    <label>金额 <input v-model.number="editModel.amount" type="number" step="0.01" /></label>
                    <label>凭证号 <input v-model="editModel.paymentRef" /></label>
                    <label v-if="txn.fields.method.value === '电子支付'">
                      渠道
                      <select v-model="editModel.channel">
                        <option v-for="c in CHANNELS" :key="c">{{ c }}</option>
                      </select>
                    </label>
                    <label>油枪号 <input v-model="editModel.nozzleId" /></label>
                    <label>备注 <input v-model="editModel.note" /></label>
                    <div class="actions">
                      <button type="button" @click="saveEdit">保存修改</button>
                      <button class="secondary" type="button" @click="editingKey = null">取消</button>
                    </div>
                  </div>

                  <div v-if="txn.conflict" class="conflict-panel">
                    <p class="conflict-title">同字段双方都改过，已保留两版，请站长选择保留版本（不按后到覆盖）：</p>
                    <div v-for="c in txn.conflict" :key="c.field" class="conflict-field">
                      <span class="conflict-name">{{ TXN_FIELD_LABELS[c.field] }}</span>
                      <label class="conflict-side" :class="{ picked: choiceFor(txn.key, c.field) === 'local' }">
                        <input
                          type="radio"
                          :checked="choiceFor(txn.key, c.field) === 'local'"
                          @change="setChoice(txn.key, c.field, 'local')"
                        />
                        本端：{{ c.local.value || "（空）" }}
                        <em>{{ c.local.updatedBy }} · v{{ c.local.version }} · {{ fmtTime(c.local.updatedAt) }}</em>
                      </label>
                      <label class="conflict-side" :class="{ picked: choiceFor(txn.key, c.field) === 'remote' }">
                        <input
                          type="radio"
                          :checked="choiceFor(txn.key, c.field) === 'remote'"
                          @change="setChoice(txn.key, c.field, 'remote')"
                        />
                        远端：{{ c.remote.value || "（空）" }}
                        <em>{{ c.remote.updatedBy }} · v{{ c.remote.version }} · {{ fmtTime(c.remote.updatedAt) }}</em>
                      </label>
                    </div>
                    <button type="button" @click="submitResolution(txn)">提交站长处理结果</button>
                  </div>
                </div>
                <div v-if="txnsOf(batch).length === 0" class="empty">本批次暂无流水</div>
              </div>

              <div class="totals">
                <span>现金 {{ fmtMoney(totalsOf(batch)?.cash) }}</span>
                <span>电子 {{ fmtMoney(totalsOf(batch)?.digital) }}</span>
                <span>油枪应收 {{ fmtMoney(totalsOf(batch)?.expected) }}</span>
                <span :class="{ 'num-danger': (totalsOf(batch)?.diff ?? 0) !== 0 }">
                  差额 {{ fmtDiff(batch.status === "frozen" ? batch.settledDiff : totalsOf(batch)?.diff) }}
                </span>
                <span v-if="(totalsOf(batch)?.dupCount ?? 0) > 0" class="badge muted">
                  重复剔除 {{ totalsOf(batch)?.dupCount }}
                </span>
                <span v-if="(totalsOf(batch)?.conflictCount ?? 0) > 0" class="badge danger">
                  待处理 {{ totalsOf(batch)?.conflictCount }}
                </span>
              </div>

              <div class="actions">
                <button
                  v-if="batch.status === 'open'"
                  type="button"
                  :disabled="(totalsOf(batch)?.conflictCount ?? 0) > 0"
                  :title="(totalsOf(batch)?.conflictCount ?? 0) > 0 ? '存在待处理冲突' : '复核后冻结批次与关联流水'"
                  @click="freeze(batch)"
                >站长复核冻结</button>
                <button
                  v-if="pendingOf(batch) > 0 || batch.syncStatus === 'pending' || batch.syncError"
                  class="secondary"
                  type="button"
                  @click="store.syncNow"
                >同步本批次</button>
              </div>
            </article>
          </div>

          <div v-if="chartRows.length > 0" class="mini-chart">
            <p class="hint">各批次差额（应收 vs 实收）</p>
            <div v-for="row in chartRows" :key="row.title" class="bar">
              <span>{{ row.title }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :class="{ negative: (row.diff ?? 0) < 0 }"
                  :style="{ width: `${(Math.abs(row.diff ?? 0) / maxAbsDiff) * 100}%` }"
                />
              </div>
              <strong>{{ fmtDiff(row.diff) }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
