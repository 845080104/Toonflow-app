<template>
  <div v-if="job || error" class="mediaTaskStatus nodrag nopan nowheel" @pointerdown.stop @wheel.stop>
    <div class="taskSummary" role="status">
      <span>{{ job ? `${labels[job.status]} · ${phases[job.phase] || job.phase}` : error }}</span>
      <el-button v-if="job?.canResume" text size="small" :disabled="busy" @click="$emit('resume')">继续查询</el-button>
      <el-button v-if="job?.status === 'unknown'" text size="small" @click="$emit('stop')">停止等待</el-button>
    </div>
    <div v-if="job?.upstream" class="taskId">上游任务：{{ job.upstream.id }}</div>
    <div v-if="job?.error" class="taskError">{{ job.error }}</div>
    <details v-if="job?.logs.length">
      <summary>任务日志</summary>
      <ol><li v-for="(entry, index) in job.logs" :key="index"><time>{{ new Date(entry.time).toLocaleString() }}</time> {{ entry.message }}</li></ol>
    </details>
  </div>
</template>
<script setup lang="ts">
import { ElButton } from "element-plus";
import type { MediaJob } from "@toonflow/nodes-scaffold/runtime";
defineProps<{ job: MediaJob | null; error?: string; busy?: boolean }>();
defineEmits<{ resume: []; stop: [] }>();
const labels = { queued: "待处理", running: "处理中", succeeded: "已完成", failed: "失败", cancelled: "已停止等待", unknown: "提交结果待确认" };
const phases: Record<string, string> = { queued: "已保存", starting: "后台启动", preparing: "准备素材", submitting: "提交上游", submitted: "上游已接收", polling: "查询上游", downloading: "保存结果", completed: "已保存", error: "发生错误", cancelled: "已停止", unknown: "请核对供应商记录" };
</script>
<style scoped lang="scss">
.mediaTaskStatus { margin: 8px 0; padding: 8px 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; font-size: 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere;
  .taskSummary { display: flex; align-items: center; gap: 8px; }
  .taskId { margin-top: 4px; }
  .taskError { margin-top: 4px; color: var(--el-color-danger); }
  details { margin-top: 6px; } summary { cursor: pointer; }
  ol { max-height: 200px; overflow: auto; padding-left: 20px; } li { padding: 3px 0; } time { margin-right: 4px; }
}
</style>
