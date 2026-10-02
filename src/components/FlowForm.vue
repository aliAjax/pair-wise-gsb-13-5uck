<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  DIGITAL_OPTIONS,
  FLOW_TYPE_OPTIONS,
  TYPE_FIELDS,
  dateLabel,
} from "../meta";
import { useStore } from "../store";
import type { EditableField, FlowType, FlowValues } from "../types";

const store = useStore();

const form = reactive<{
  batchId: string;
  type: FlowType;
  values: Record<string, string | number>;
}>({
  batchId: "",
  type: "nozzle",
  values: {},
});
const error = ref("");

const fields = computed(() => TYPE_FIELDS[form.type]);
const numericFields = new Set<EditableField>(["startReading", "endReading", "amount"]);
const labelOf: Record<string, string> = {
  nozzleId: "油枪编号",
  startReading: "起始读数",
  endReading: "结束读数",
  amount: "金额（元）",
  method: "支付方式",
  voucher: "支付凭证号",
  note: "备注",
};

const choices = computed(() => store.openBatchChoices);

function ensureBatchSelected() {
  if (!form.batchId && choices.value.length) form.batchId = choices.value[0].id;
}
ensureBatchSelected();

function switchType(type: FlowType) {
  form.type = type;
  form.values = {};
}

function submit() {
  error.value = "";
  if (!form.batchId) {
    error.value = "请先创建或选择一个开放批次（冻结批次的新流水会自动归入下一批次）";
    return;
  }
  if (form.type === "nozzle") {
    if (!form.values.nozzleId) {
      error.value = "请填写油枪编号";
      return;
    }
  } else {
    const amount = Number(form.values.amount ?? 0);
    if (!amount || amount <= 0) {
      error.value = "请填写收单金额";
      return;
    }
    if (form.type === "digital" && !form.values.method) {
      error.value = "请选择支付方式";
      return;
    }
    if (!String(form.values.voucher ?? "").trim()) {
      error.value = "请填写支付凭证号：同一凭证号跨终端重复录入会被挂起待站长处理";
      return;
    }
  }

  const values: FlowValues = {};
  for (const f of fields.value) {
    const v = form.values[f];
    if (v === undefined || v === "") continue;
    values[f] = numericFields.has(f) ? Number(v) : String(v);
  }
  const key = store.addFlow({ type: form.type, batchId: form.batchId, values });
  form.values = {};
  if (key) {
    // 保存成功（在线会立即同步，离线进入待同步队列）
  }
}
</script>

<template>
  <form class="panel inner-form" @submit.prevent="submit">
    <h2>录入流水</h2>
    <p class="panel-hint">
      流水身份 = 当前终端编号 + 终端内自增流水号，断网时两名值班员各自录入也不会在重连后重复计算；同字段双方都改则挂起两版。
    </p>

    <div class="seg">
      <button
        v-for="opt in FLOW_TYPE_OPTIONS"
        :key="opt.value"
        type="button"
        class="seg-btn"
        :class="{ active: form.type === opt.value }"
        @click="switchType(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <div class="form-grid">
      <label class="span2">
        归属批次
        <select v-model="form.batchId">
          <option value="" disabled>请选择开放批次</option>
          <option v-for="c in choices" :key="c.id" :value="c.id">
            {{ dateLabel(c.businessDate) }} {{ c.shift }}<template v-if="c.pending">（待同步）</template>
          </option>
        </select>
      </label>

      <label v-if="fields.includes('nozzleId')">
        {{ labelOf.nozzleId }}
        <input v-model="form.values.nozzleId" placeholder="如 3号枪" />
      </label>
      <label v-if="fields.includes('startReading')">
        {{ labelOf.startReading }}
        <input v-model.number="form.values.startReading" type="number" min="0" />
      </label>
      <label v-if="fields.includes('endReading')">
        {{ labelOf.endReading }}
        <input v-model.number="form.values.endReading" type="number" min="0" />
      </label>
      <label v-if="fields.includes('amount')">
        {{ labelOf.amount }}
        <input v-model.number="form.values.amount" type="number" min="0" step="0.01" />
      </label>
      <label v-if="fields.includes('method')">
        {{ labelOf.method }}
        <select v-model="form.values.method">
          <option value="" disabled>请选择</option>
          <option v-for="m in DIGITAL_OPTIONS" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label v-if="fields.includes('voucher')">
        {{ labelOf.voucher }}
        <input v-model="form.values.voucher" placeholder="小票号 / 支付平台交易号" />
      </label>
      <label v-if="fields.includes('note')" class="span2">
        {{ labelOf.note }}
        <input v-model="form.values.note" placeholder="现场说明（可选）" />
      </label>
    </div>

    <p v-if="error" class="form-error">{{ error }}</p>
    <button type="submit">保存流水</button>
  </form>
</template>
