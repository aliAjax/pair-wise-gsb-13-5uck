<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { SHIFT_OPTIONS, dateLabel } from "../meta";
import { useStore } from "../store";
import type { ShiftType } from "../types";

const store = useStore();
const emit = defineEmits<{ created: [batchId: string] }>();

const today = new Date().toISOString().slice(0, 10);
const batchForm = reactive<{ businessDate: string; shift: ShiftType | "" }>({
  businessDate: today,
  shift: "",
});

function submitBatch() {
  if (!batchForm.shift || !batchForm.businessDate) return;
  const id = store.createBatch(batchForm.shift, batchForm.businessDate);
  emit("created", id);
}
</script>

<template>
  <form class="panel inner-form" @submit.prevent="submitBatch">
    <h2>新建交接批次</h2>
    <p class="panel-hint">
      一个班次 = 油枪读数 + 现金 + 电子支付流水的归集单位。离线时保存在本终端，重连同班次同日批次自动合并。
    </p>
    <div class="form-grid">
      <label>
        营业日期
        <input v-model="batchForm.businessDate" type="date" required />
      </label>
      <label>
        班次
        <select v-model="batchForm.shift" required>
          <option value="">请选择</option>
          <option v-for="s in SHIFT_OPTIONS" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button type="submit">创建批次</button>
    </div>
    <p class="panel-foot">
      已有开放批次：
      <span v-if="store.openBatchChoices.length === 0" class="muted">无</span>
      <span v-for="(c, i) in store.openBatchChoices" :key="c.id" class="chip">
        {{ dateLabel(c.businessDate) }} {{ c.shift }}<template v-if="c.pending"> ·待同步</template><span
          v-if="i < store.openBatchChoices.length - 1">；</span>
      </span>
    </p>
  </form>
</template>
