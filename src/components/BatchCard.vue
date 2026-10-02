<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { dateLabel, formatLiters, formatMoney, formatTime } from "../meta";
import { useStore } from "../store";
import type { ClientBatch, ServerBatch } from "../types";
import FlowRowView from "./FlowRow.vue";

const props = defineProps<{
  batch: ServerBatch | ClientBatch;
  ghost?: boolean;
}>();

const store = useStore();

const isServer = (b: ServerBatch | ClientBatch): b is ServerBatch =>
  "status" in b && typeof (b as ServerBatch).carryDiff === "number";

const serverBatch = computed(() =>
  isServer(props.batch) ? (props.batch as ServerBatch) : undefined
);
const frozen = computed(() => serverBatch.value?.status === "frozen");
const legacy = computed(() => !!serverBatch.value?.legacy);

const rows = computed(() => store.rowsForBatch(props.batch.id));

const totals = computed(() =>
  serverBatch.value ? store.totalsForBatch(serverBatch.value) : ghostTotals.value
);

/** 影子批次（尚未同步）的合计只来自各终端待同步流水 */
const ghostTotals = computed(() => {
  let liters = 0;
  let cash = 0;
  let digital = 0;
  for (const r of rows.value) {
    if (r.type === "nozzle") {
      liters += Math.max(0, Number(r.values.endReading ?? 0) - Number(r.values.startReading ?? 0));
    } else if (r.type === "cash") {
      cash += Number(r.values.amount ?? 0);
    } else {
      digital += Number(r.values.amount ?? 0);
    }
  }
  return { liters, cash, digital, expected: cash + digital };
});

const liveCarry = computed(() =>
  serverBatch.value ? store.liveCarry(serverBatch.value) : 0
);

const blockers = computed(() =>
  serverBatch.value ? store.batchBlockers(props.batch.id) : []
);

// ---------- 复核弹窗 ----------
const reviewing = ref(false);
const reviewError = ref("");
const reviewForm = reactive({
  cashActual: 0,
  digitalActual: 0,
  reviewer: "",
  note: "",
});

function openReview() {
  reviewForm.cashActual = totals.value.cash;
  reviewForm.digitalActual = totals.value.digital;
  reviewForm.reviewer = "";
  reviewForm.note = "";
  reviewError.value = "";
  reviewing.value = true;
}

function submitReview() {
  if (!serverBatch.value) return;
  const result = store.reviewBatch(
    serverBatch.value.id,
    Number(reviewForm.cashActual) || 0,
    Number(reviewForm.digitalActual) || 0,
    reviewForm.reviewer,
    reviewForm.note
  );
  if (!result.ok) reviewError.value = result.reason ?? "复核失败";
  else reviewing.value = false;
}

function reviewOld() {
  store.reviewLegacy(props.batch.id);
}

const cashGap = computed(() => totals.value.cash - Number(reviewForm.cashActual || 0));
const digitalGap = computed(
  () => totals.value.digital - Number(reviewForm.digitalActual || 0)
);
const projectedDiff = computed(
  () => liveCarry.value + totals.value.expected
    - (Number(reviewForm.cashActual || 0) + Number(reviewForm.digitalActual || 0))
);

const terminalSources = computed(() => {
  const ids = new Set(rows.value.map((r) => String(r.originTerminal)));
  return [...ids];
});
</script>

<template>
  <article class="batch-card" :class="{ frozen, legacy: legacy || ghost }">
    <header class="batch-head">
      <div>
        <p class="batch-title">
          {{ dateLabel(batch.businessDate) }} {{ batch.shift }}
          <span v-if="ghost" class="mini-tag warn">待同步批次</span>
          <span v-else-if="legacy" class="mini-tag">升级记录</span>
          <span v-else-if="frozen" class="mini-tag">已冻结</span>
          <span v-else class="mini-tag ok">开放中</span>
        </p>
        <p class="batch-meta">
          批次 {{ batch.id }} · 创建 {{ formatTime(batch.createdAt) }}
          <template v-if="terminalSources.length">
            · 来源终端 {{ terminalSources.join("、") }}
          </template>
          <template v-if="frozen && serverBatch?.frozenAt">
            · 冻结 {{ formatTime(serverBatch.frozenAt) }}
          </template>
        </p>
      </div>
      <div v-if="frozen && serverBatch?.reviewer" class="reviewer">
        复核人：{{ serverBatch.reviewer }}
      </div>
    </header>

    <div class="totals-grid">
      <div class="total-cell">
        <span>油品销量（泵码）</span>
        <b>{{ formatLiters(totals.liters) }}</b>
      </div>
      <div class="total-cell">
        <span>现金应收</span>
        <b>{{ formatMoney(totals.cash) }}</b>
        <small v-if="frozen">实收 {{ formatMoney(serverBatch?.cashActual) }}</small>
      </div>
      <div class="total-cell">
        <span>电子应收</span>
        <b>{{ formatMoney(totals.digital) }}</b>
        <small v-if="frozen">实收 {{ formatMoney(serverBatch?.digitalActual) }}</small>
      </div>
      <div class="total-cell">
        <span>承接上次差额</span>
        <b :class="{ negative: liveCarry !== 0 }">{{ formatMoney(liveCarry) }}</b>
      </div>
    </div>

    <!-- 结算差额：冻结时定值；被迟到流水失效后显示删除线 -->
    <div v-if="frozen && serverBatch?.settlementDiff !== undefined" class="settle">
      <template v-if="serverBatch.settlementInvalid">
        <span class="settle-label">本次结算差额（已失效）：</span>
        <s class="settle-diff">{{ formatMoney(serverBatch.settlementDiff) }}</s>
        <span class="settle-hint">
          冻结后有迟到流水，已归入下一批次重算
          <template v-if="serverBatch.supersededByBatchId">
            → 批次 {{ serverBatch.supersededByBatchId.slice(0, 10) }}…
          </template>
        </span>
      </template>
      <template v-else>
        <span class="settle-label">本次结算差额：</span>
        <b class="settle-diff" :class="{ negative: serverBatch.settlementDiff !== 0 }">
          {{ formatMoney(serverBatch.settlementDiff) }}
        </b>
        <span class="settle-hint">承接差额 + 应收 - 实收</span>
      </template>
    </div>
    <div v-if="serverBatch?.reviewNote" class="review-note">复核备注：{{ serverBatch.reviewNote }}</div>
    <div v-else-if="legacy && serverBatch?.legacyNote" class="review-note">
      原备注：{{ serverBatch.legacyNote }}
    </div>

    <div class="flow-list">
      <FlowRowView v-for="row in rows" :key="row.key" :row="row" />
      <div v-if="rows.length === 0" class="empty">本批次暂无流水</div>
    </div>

    <footer v-if="!frozen" class="batch-footer">
      <div v-if="blockers.length" class="blockers">
        <span v-for="b in blockers" :key="b" class="mini-tag warn">{{ b }}</span>
      </div>
      <button v-if="legacy" type="button" @click="reviewOld">标记为已复核（仅存档）</button>
      <button v-else-if="!ghost" type="button" :disabled="blockers.length > 0" @click="openReview">
        站长复核并冻结
      </button>
      <span v-else class="settle-hint">批次同步后即可复核；写入失败时保留待同步，重试自动补传</span>
    </footer>

    <!-- 复核弹窗 -->
    <div v-if="reviewing" class="modal-mask" @click.self="reviewing = false">
      <div class="modal wide">
        <h3>复核批次 · {{ dateLabel(batch.businessDate) }} {{ batch.shift }}</h3>
        <p class="modal-hint">
          复核通过后批次与全部关联流水将被冻结，任何终端不能再改金额；之后到达的流水自动归入下一批次，本批差额随之失效重算。
        </p>
        <div class="modal-grid">
          <label>
            现金实收（应收 {{ formatMoney(totals.cash) }}）
            <input v-model.number="reviewForm.cashActual" type="number" />
          </label>
          <label>
            电子实收（应收 {{ formatMoney(totals.digital) }}）
            <input v-model.number="reviewForm.digitalActual" type="number" />
          </label>
          <label>
            复核人
            <input v-model="reviewForm.reviewer" placeholder="站长签名" />
          </label>
          <label class="span2">
            复核备注
            <input v-model="reviewForm.note" placeholder="账实一致 / 差异说明" />
          </label>
        </div>
        <div class="review-preview">
          <span>现金差：<b :class="{ negative: cashGap !== 0 }">{{ formatMoney(cashGap) }}</b></span>
          <span>电子差：<b :class="{ negative: digitalGap !== 0 }">{{ formatMoney(digitalGap) }}</b></span>
          <span>
            结算差额（含承接 {{ formatMoney(liveCarry) }}）：
            <b :class="{ negative: projectedDiff !== 0 }">{{ formatMoney(projectedDiff) }}</b>
          </span>
        </div>
        <p v-if="reviewError" class="form-error">{{ reviewError }}</p>
        <div class="modal-actions">
          <button type="button" class="secondary" @click="reviewing = false">取消</button>
          <button
            type="button"
            :disabled="!reviewForm.reviewer.trim()"
            @click="submitReview"
          >
            确认冻结
          </button>
        </div>
      </div>
    </div>
  </article>
</template>
