import { computed, onMounted, ref, type Ref } from "vue";
import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";
import type { useNodeAi, NodeData } from "@toonflow/nodes-scaffold/runtime";
import type { NodeOutputs } from "@toonflow/nodes-scaffold/values";

export function useNodeGeneration(outputs: Readonly<Ref<NodeOutputs>>, cancel: () => void, restore?: {
  ai: ReturnType<typeof useNodeAi>; directory: () => Promise<{ directory: string }>; data: NodeData; type: "image" | "video" | "audio";
}) {
  const status = ref<"idle" | "running" | "succeeded" | "failed">("idle");
  const error = ref("");
  const restoring = ref(!!restore);
  const job = computed(() => restore?.ai.mediaJob.value ?? null);
  const generating = computed(() => restoring.value || status.value === "running" || !!job.value && ["queued", "running"].includes(job.value.status));
  const getStatus = () => ({ status: generating.value ? "running" : job.value?.status ?? status.value, outputs: outputs.value,
    ...(job.value ? { task: job.value } : {}), ...(job.value?.error || error.value ? { error: job.value?.error || error.value } : {}) });
  function applyResult(result: { path: string; mimeType: string }[] | null) {
    if (!restore || !result?.length || !job.value || restore.data.mediaJobApplied === job.value.id) return;
    const file = result[0]!;
    Object.assign(outputs.value, { [restore.type]: { dataType: restore.type.toUpperCase(), value: { url: file.path, mimeType: file.mimeType } } });
    restore.data.mediaJobApplied = job.value.id;
  }
  onMounted(async () => {
    if (!restore) return;
    try { const { directory } = await restore.directory(); applyResult(await restore.ai.restoreMediaGeneration(directory)); }
    catch (failure) { error.value = failure instanceof Error ? failure.message : "恢复任务查询失败"; }
    finally { restoring.value = false; }
  });
  async function resume() {
    if (!restore || generating.value) return;
    restoring.value = true;
    try { applyResult(await restore.ai.resumeMediaGeneration()); }
    catch (failure) { error.value = failure instanceof Error ? failure.message : "任务查询失败"; }
    finally { restoring.value = false; }
  }
  function stop() { cancel(); if (restore) void restore.ai.controlMediaJob("cancel").catch(failure => { error.value = failure.message; }); }

  nodeTools.register({
    name: "getGenerationStatus",
    description: "查询服务端持久化生成状态、任务阶段、上游任务 ID、日志与错误。刷新后继续查询同一个任务，running 只表示本地任务运行，task.upstream 才表示上游接收。当前输出可能来自之前的生成",
    parameters: z.strictObject({}),
    execute: getStatus,
  });
  nodeTools.register({
    name: "cancelGeneration",
    description: "请求停止当前后台生成；cancellationRequested 表示已发出停止请求，随后用 getGenerationStatus 查询终止状态。不会删除已有输出，不能保证供应商撤销任务或费用",
    parameters: z.strictObject({}),
    execute() {
      const cancellationRequested = generating.value;
      if (cancellationRequested) stop();
      return { ...getStatus(), cancellationRequested };
    },
  });

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (generating.value) throw new Error("节点正在生成，请等待完成");
    status.value = "running";
    error.value = "";
    if (restore) restore.ai.mediaJob.value = null;
    try {
      const result = await task();
      status.value = "succeeded";
      if (restore && job.value?.status === "succeeded") restore.data.mediaJobApplied = job.value.id;
      return result;
    } catch (failure) {
      status.value = "failed";
      const message = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message;
      error.value = failure instanceof Error && failure.name === "AbortError" ? "生成已取消"
        : message || (failure instanceof Error ? failure.message : "生成失败");
      throw failure;
    }
  }

  return { generating, run, job, resume, stop, error };
}
