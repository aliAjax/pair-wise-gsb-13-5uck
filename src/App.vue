<script setup lang="ts">
import { TERMINAL_NAMES } from "./meta";
import { useStore } from "./store";
import { TERMINAL_IDS } from "./types";
import BatchCard from "./components/BatchCard.vue";
import BatchForm from "./components/BatchForm.vue";
import FlowForm from "./components/FlowForm.vue";
import TerminalPanel from "./components/TerminalPanel.vue";

const store = useStore();

const stack = ["Vue3", "Vite", "TypeScript", "Pinia"];
const maxChart = Math.max(1, ...store.chartRows.map((r) => r.value));
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环 · 多终端离线交接</p>
          <h1>加油站班次交接批次</h1>
          <p class="subtitle">
            一个班次批次关联油枪读数、现金与电子支付流水；各终端离线保存，重连后按
            <b>终端编号 + 终端流水号</b> 合并，同一流水只计一次；字段双方都改则保留两版待站长裁决，
            复核后冻结批次与流水，迟到流水归入下一批并重算结算差额。
          </p>
        </div>
        <div class="stack">
          <span v-for="item in stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <!-- 模拟控制条：终端切换 / 网络 / 故障注入 -->
      <section class="control-bar">
        <div class="control-group">
          <span class="control-label">当前终端</span>
          <div class="seg">
            <button
              v-for="t in TERMINAL_IDS"
              :key="t"
              type="button"
              class="seg-btn"
              :class="{ active: store.currentTerminalId === t }"
              @click="store.switchTerminal(t)"
            >
              {{ t }} {{ TERMINAL_NAMES[t] }}
            </button>
          </div>
        </div>
        <div class="control-group">
          <label class="switch-line">
            <input
              type="checkbox"
              :checked="store.online"
              @change="store.toggleOnline(($event.target as HTMLInputElement).checked)"
            />
            网络在线
          </label>
          <label class="switch-line" :title="'开启后同步会随机中断，用于演示失败保留与重试补传'">
            <input
              type="checkbox"
              :checked="store.faultEnabled"
              @change="store.toggleFault(($event.target as HTMLInputElement).checked)"
            />
            模拟网络故障
          </label>
          <button
            type="button"
            class="secondary"
            :disabled="!store.online || store.syncing || store.pendingCount === 0"
            @click="store.sync(false)"
          >
            {{ store.syncing ? "同步中…" : `立即同步（待处理 ${store.pendingCount} 项）` }}
          </button>
        </div>
        <div class="net-state" :class="store.online ? 'online' : 'offline'">
          <span class="dot" />
          {{ store.online ? (store.syncing ? "同步中" : "在线") : "离线·本地保存" }}
        </div>
      </section>

      <!-- 通知 -->
      <transition-group name="notice" tag="div" class="notices">
        <div v-for="n in store.notices" :key="n.id" class="notice" :class="`notice-${n.kind}`">
          {{ n.text }}
        </div>
      </transition-group>

      <section class="metrics">
        <article class="metric">
          <span>开放批次</span>
          <strong>{{ store.metrics.open }}</strong>
        </article>
        <article class="metric">
          <span>已冻结批次</span>
          <strong>{{ store.metrics.frozen }}</strong>
        </article>
        <article class="metric">
          <span>各终端待同步（批次+流水）</span>
          <strong :class="{ 'metric-warn': store.metrics.pending > 0 }">
            {{ store.metrics.pending }}
          </strong>
        </article>
        <article class="metric">
          <span>待站长处理（冲突+重复）</span>
          <strong :class="{ 'metric-warn': store.metrics.issues > 0 }">
            {{ store.metrics.issues }}
          </strong>
        </article>
      </section>

      <section class="workspace v2">
        <div class="side-col">
          <BatchForm />
          <FlowForm />
        </div>

        <div class="main-col">
          <TerminalPanel />

          <section class="batch-section">
            <h2>开放批次</h2>
            <div class="batch-grid">
              <BatchCard v-for="b in store.openBatches" :key="b.id" :batch="b" />
              <BatchCard
                v-for="b in store.ghostBatches"
                :key="b.id"
                :batch="b"
                ghost
              />
              <div v-if="store.openBatches.length === 0 && store.ghostBatches.length === 0" class="empty">
                暂无开放批次，请在左侧新建
              </div>
            </div>
          </section>

          <section class="batch-section">
            <h2>已冻结批次（结算链）</h2>
            <div class="batch-grid">
              <BatchCard v-for="b in store.frozenBatches" :key="b.id" :batch="b" />
              <div v-if="store.frozenBatches.length === 0" class="empty">尚无复核冻结的批次</div>
            </div>
          </section>

          <section class="batch-section legacy-section">
            <h2>升级前的两条示例记录（只读存档）</h2>
            <p class="panel-hint">
              旧版单条交接记录已升级为批次结构，仍可查看原有销量与金额；标注「已复核」的按冻结态展示，不参与新的结算差额链。
            </p>
            <div class="batch-grid">
              <BatchCard v-for="b in store.legacyBatches" :key="b.id" :batch="b" />
            </div>
          </section>

          <div class="mini-chart">
            <div v-for="row in store.chartRows" :key="row.label" class="bar">
              <span>{{ row.label }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" />
              </div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
