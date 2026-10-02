<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  FIELD_LABELS,
  TYPE_FIELDS,
  TERMINAL_NAMES,
  formatLiters,
  formatMoney,
  formatTime,
} from "../meta";
import { useStore, type FlowRow as FlowRowVM } from "../store";
import type { EditableField, FlowValues } from "../types";

const props = defineProps<{ row: FlowRowVM }>();
const store = useStore();

const editing = ref(false);
const editError = ref("");
const draft = reactive<Record<string, string | number>>({});
const resolutionChoice = reactive<Record<string, "remote" | "local" | "custom">>({});
const resolutionCustom = reactive<Record<string, string | number>>({});
const reviewer = ref("");

const typeFields = TYPE_FIELDS[props.row.type];

function isNumeric(field: EditableField) {
  return field === "amount" || field === "startReading" || field === "endReading";
}

function fieldValue(field: EditableField, v: FlowValues) {
  const val = v[field];
  return val === undefined || val === "" ? "—" : String(val);
}

function openEdit() {
  for (const k of Object.keys(draft)) delete draft[k];
  for (const f of typeFields) {
    const v = props.row.values[f];
    draft[f] = v === undefined ? "" : v;
  }
  editError.value = "";
  editing.value = true;
}

function submitEdit() {
  const values: FlowValues = {};
  for (const f of typeFields) {
    const v = draft[f];
    if (isNumeric(f)) {
      if (v === "" || v === undefined) continue;
      values[f] = Number(v);
    } else if (v !== undefined && v !== "") {
      values[f] = String(v);
    }
  }
  const result = store.editFlow(props.row.key, values);
  if (result.ok) {
    editing.value = false;
  } else {
    editError.value = result.reason ?? "保存失败";
  }
}

function chosenValue(c: { field: EditableField; local: string | number; remote: string | number }) {
  const choice = resolutionChoice[c.field] ?? "remote";
  if (choice === "local") return c.local;
  if (choice === "custom") return resolutionCustom[c.field] ?? "";
  return c.remote;
}

function submitResolution() {
  if (!reviewer.value.trim()) return;
  const resolutions = props.row.conflicts.map((c) => ({
    field: c.field,
    value: chosenValue(c),
  }));
  store.resolveConflicts(props.row.key, resolutions, reviewer.value.trim());
}

function keepThis() {
  if (!reviewer.value.trim()) return;
  store.resolveDuplicateFlow(props.row.key, "keep", reviewer.value.trim());
}
function voidThis() {
  if (!reviewer.value.trim()) return;
  store.resolveDuplicateFlow(props.row.key, "void", reviewer.value.trim());
}

const twin = computed(() =>
  props.row.duplicateOf ? store.flowByKey(props.row.duplicateOf) : undefined
);

const statusText: Record<string, string> = {
  active: "有效",
  conflict: "字段冲突",
  duplicate: "疑似重复",
  void: "已作废",
};

const literTotal = () => {
  if (props.row.type !== "nozzle") return null;
  const v = props.row.values;
  const liters = Math.max(0, Number(v.endReading ?? 0) - Number(v.startReading ?? 0));
  return formatLiters(liters);
};

const moneyTotal = () =>
  props.row.type === "nozzle"
    ? null
    : formatMoney(Number(props.row.values.amount ?? 0));
</script>

<template>
  <div class="flow-row" :class="`is-${row.status}`">
    <div class="flow-main">
      <div class="flow-id">
        <span class="flow-key">{{ row.key }}</span>
        <span class="mini-tag">{{ store.flowTypeLabel(row.type) }}</span>
        <span v-if="row.originTerminal !== 'LEGACY'" class="mini-tag">
          {{ TERMINAL_NAMES[row.originTerminal as string] ?? row.originTerminal }}
        </span>
        <span v-if="row.pending" class="mini-tag warn">待同步</span>
        <span v-if="row.lateForBatchId" class="mini-tag late">迟到流水·归入下一批</span>
        <span v-if="row.originTerminal === 'LEGACY'" class="mini-tag">升级数据</span>
        <span class="mini-tag" :class="`badge-${row.status}`">{{ statusText[row.status] }}</span>
      </div>

      <div class="flow-fields">
        <template v-for="f in typeFields" :key="f">
          <span v-if="row.values[f] !== undefined && row.values[f] !== ''">
            {{ FIELD_LABELS[f] }}：<b>{{ fieldValue(f, row.values) }}</b>
          </span>
        </template>
        <span v-if="literTotal()" class="flow-sum">泵码销量 {{ literTotal() }}</span>
        <span v-if="moneyTotal()" class="flow-sum">金额 {{ moneyTotal() }}</span>
        <span class="flow-time">{{ formatTime(row.updatedAt) }}</span>
      </div>

      <div class="flow-actions">
        <button
          v-if="row.pendingOnly || !row.server || row.server.status === 'active' || row.server.status === 'conflict' || row.server.status === 'duplicate'"
          type="button"
          class="link-btn"
          @click="openEdit"
        >
          {{ row.pendingOnly ? "修改待同步草稿" : "修改" }}
        </button>
      </div>
    </div>

    <!-- 字段冲突：两版并存，站长逐字段裁决，不能后到覆盖 -->
    <div v-if="row.conflicts.length" class="conflict-box">
      <p class="box-title">⚠ 双方都修改过以下字段，已保留两版待站长处理：</p>
      <table class="conflict-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>后到版本</th>
            <th>在先版本</th>
            <th>裁决</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in row.conflicts" :key="c.field">
            <td>{{ FIELD_LABELS[c.field] }}</td>
            <td>{{ c.local === "" ? "（空）" : c.local }}</td>
            <td>{{ c.remote === "" ? "（空）" : c.remote }}</td>
            <td>
              <select v-model="resolutionChoice[c.field]">
                <option value="remote">采用在先：{{ c.remote === "" ? "空" : c.remote }}</option>
                <option value="local">采用后到：{{ c.local === "" ? "空" : c.local }}</option>
                <option value="custom">站长指定…</option>
              </select>
              <input
                v-if="resolutionChoice[c.field] === 'custom'"
                v-model="resolutionCustom[c.field]"
                :type="isNumeric(c.field) ? 'number' : 'text'"
                placeholder="输入裁决值"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="resolve-line">
        <input v-model="reviewer" placeholder="站长签名（必填）" class="reviewer-input" />
        <button type="button" :disabled="!reviewer.trim()" @click="submitResolution">确认裁决</button>
      </div>
    </div>

    <!-- 重复支付：同一凭证号两笔，只允许一笔计收 -->
    <div v-else-if="row.status === 'duplicate'" class="conflict-box dup">
      <p class="box-title">
        ⚠ 与流水 <b>{{ row.duplicateOf }}</b>
        <template v-if="twin"> 凭证号「{{ twin.voucher }}」相同</template>
        ，疑似同一笔支付被两名值班员重复录入，两笔均暂不计入金额。
      </p>
      <div class="resolve-line">
        <input v-model="reviewer" placeholder="站长签名（必填）" class="reviewer-input" />
        <button type="button" :disabled="!reviewer.trim()" @click="keepThis">保留本笔计收 / 另一笔作废</button>
        <button type="button" class="secondary" :disabled="!reviewer.trim()" @click="voidThis">
          作废本笔 / 另一笔计收
        </button>
      </div>
    </div>

    <div v-if="row.status === 'void'" class="void-note">本笔已作废，不计入批次金额。</div>

    <!-- 编辑弹层 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = false">
      <div class="modal">
        <h3>修改流水 {{ row.key }}</h3>
        <p class="modal-hint">
          离线时仅保存在本终端；若另一终端也改过同字段，同步后将保留两版待站长裁决，不会后到覆盖。
        </p>
        <div class="modal-grid">
          <label v-for="f in typeFields" :key="f">
            {{ FIELD_LABELS[f] }}
            <input v-model="draft[f]" :type="isNumeric(f) ? 'number' : 'text'" />
          </label>
        </div>
        <p v-if="editError" class="form-error">{{ editError }}</p>
        <div class="modal-actions">
          <button type="button" class="secondary" @click="editing = false">取消</button>
          <button type="button" @click="submitEdit">提交修改</button>
        </div>
      </div>
    </div>
  </div>
</template>
