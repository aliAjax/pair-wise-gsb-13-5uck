<script setup lang="ts">
import { TERMINAL_NAMES, formatTime } from "../meta";
import { useStore } from "../store";
import { TERMINAL_IDS } from "../types";

const store = useStore();
</script>

<template>
  <section class="panel terminal-panel">
    <h2>各终端同步状态</h2>
    <table class="terminal-table">
      <thead>
        <tr>
          <th>终端编号</th>
          <th>终端</th>
          <th>待同步批次</th>
          <th>待同步流水</th>
          <th>最近成功同步</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="t in TERMINAL_IDS"
          :key="t"
          :class="{ current: t === store.currentTerminalId }"
        >
          <td><b>{{ t }}</b></td>
          <td>{{ TERMINAL_NAMES[t] }}</td>
          <td>
            <span :class="{ pending: Object.keys(store.locals[t].pendingBatches).length > 0 }">
              {{ Object.keys(store.locals[t].pendingBatches).length }}
            </span>
          </td>
          <td>
            <span :class="{ pending: Object.keys(store.locals[t].pendingFlows).length > 0 }">
              {{ Object.keys(store.locals[t].pendingFlows).length }}
            </span>
          </td>
          <td>{{ formatTime(store.locals[t].lastSyncAt) }}</td>
          <td>
            <button
              v-if="t === store.currentTerminalId"
              type="button"
              class="secondary"
              :disabled="!store.online || store.syncing"
              @click="store.sync(false)"
            >
              {{ store.syncing ? "同步中…" : "立即重试同步" }}
            </button>
            <span v-else class="mini-tag">切换后操作</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="panel-hint">
      待处理：字段冲突 <b>{{ store.conflictCount }}</b> 笔 · 疑似重复支付
      <b>{{ store.duplicateCount }}</b> 笔（在下方批次内由站长逐笔裁决）
    </p>
  </section>
</template>
