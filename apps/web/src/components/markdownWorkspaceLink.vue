<template>
  <span class="workspaceLink">
    <button type="button" :title="path" @click="visible = true"><slot /></button>
    <el-dialog v-model="visible" :title="path" width="min(900px, 92vw)" alignCenter appendToBody destroyOnClose>
      <p v-if="loading || error" :role="error ? 'alert' : 'status'">{{ loading ? '正在读取…' : error }}</p>
      <pre v-else class="fileContent">{{ content }}</pre>
    </el-dialog>
  </span>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ directory: string; path: string }>();
const visible = ref(false);
const loading = ref(false);
const error = ref("");
const content = ref("");

watch([visible, () => props.directory, () => props.path], async ([opened, directory, path], _previous, onCleanup) => {
  content.value = "";
  error.value = "";
  loading.value = false;
  if (!opened) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  try {
    const snapshot = await useWorkspaceFiles(directory).readTextSnapshot(path, { maxBytes: 2 * 1024 * 1024, signal: controller.signal });
    if (!controller.signal.aborted) content.value = snapshot.text;
  } catch (cause) {
    if (!controller.signal.aborted) error.value = axios.isAxiosError<{ message?: string }>(cause)
      ? cause.response?.data?.message || "无法读取工作区文件"
      : cause instanceof Error ? cause.message : "无法读取工作区文件";
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
});
</script>

<style scoped lang="scss">
.workspaceLink {
  button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--el-color-primary);
    font: inherit;
    text-align: inherit;
    text-decoration: underline;
    cursor: pointer;

    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
  }
}
.fileContent {
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.7;
}
</style>
