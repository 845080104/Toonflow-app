import { mkdirSync, readFileSync, readdirSync, writeAtomicSync } from "@toonflow/file";
import { dirname, join } from "node:path";
import type { GeneratedMedia, MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import type { ProviderTools } from "@toonflow/providers";
import conf from "@/utils/conf";
import { generateMedia } from "@/utils/media/generation";
import { mediaErrorMessage } from "@/utils/media/provider";

type MediaType = "image" | "video" | "audio";
type Job = {
  id: string; directory: string; nodeId: string; mediaType: MediaType; request: MediaGenerationRequest;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  phase: string; createdAt: string; updatedAt: string; error?: string; result: GeneratedMedia[];
  upstream?: { id: string; protocol: string };
  logs: { time: string; phase: string; message: string }[];
};
const active = new Map<string, { job: Job; controller: AbortController }>();
function directory() { return join(dirname(conf.path), "mediaJobs"); }
function persist(job: Job) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  writeAtomicSync(join(directory(), `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
}
function log(job: Job, phase: string, message: string) {
  job.phase = phase;
  job.updatedAt = new Date().toISOString();
  if (job.logs.at(-1)?.message !== message || job.logs.at(-1)?.phase !== phase) job.logs.push({ time: job.updatedAt, phase, message: message.slice(0, 2000) });
  job.logs = job.logs.slice(-200);
  persist(job);
}
function read(id: string): Job | undefined {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error("任务 ID 无效"), { status: 400 });
  const running = active.get(id)?.job;
  if (running) return running;
  try { return JSON.parse(readFileSync(join(directory(), `${id}.json`), "utf8")) as Job; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
// ACT: 节点首次恢复扫描历史记录；开始轮询后按任务 ID 直接读取。大量历史时可增加节点索引。
function latest(directoryPath: string, nodeId: string) {
  let entries: string[];
  try { entries = readdirSync(directory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  return entries.filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(file => read(file.slice(0, -5))!)
    .filter(job => job.directory === directoryPath && job.nodeId === nodeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
function view(job: Job) {
  const { request, directory: _directory, ...data } = job;
  return { ...data, providerId: request.providerId, modelId: request.modelId, canResume: !!job.upstream && job.status !== "succeeded" && !active.has(job.id) };
}
function start(job: Job) {
  if (active.has(job.id)) return;
  const controller = new AbortController();
  active.set(job.id, { job, controller });
  const recovering = !!job.upstream;
  job.status = "running"; job.error = undefined;
  log(job, recovering ? "polling" : "starting", recovering ? "继续查询已保存的上游任务" : "服务端后台任务已启动");
  const task: ProviderTools["task"] = {
    upstream: job.upstream,
    save(upstream) {
      if (!upstream.id || upstream.id.length > 256 || upstream.protocol.length > 100) throw new Error("上游任务标识无效");
      job.upstream = { ...upstream };
      log(job, "submitted", `上游已接收，任务 ID：${upstream.id}`);
    },
    log: (phase, message) => log(job, phase, message),
  };
  // ACT: 任务不绑定 HTTP 连接；页面刷新仅中断前端等待。恢复有 ID 的任务只轮询，禁止重发创建请求。
  void generateMedia(job.directory, job.mediaType, job.request, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]), task).then(result => {
    job.result = result; job.status = "succeeded";
    log(job, "completed", "生成完成，文件已保存到工作区");
  }).catch(error => {
    job.status = controller.signal.aborted ? "cancelled" : "failed";
    const config = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
    job.error = mediaErrorMessage(error instanceof Error ? error.message : error, config?.[job.request.providerId] ?? {}) || "生成失败";
    if (/certificate|cert_|tls/i.test(job.error)) job.error = `HTTPS 证书校验失败：${job.error}`;
    log(job, controller.signal.aborted ? "cancelled" : "error", job.error);
  }).finally(() => { active.delete(job.id); });
}
export function submitJob(directoryPath: string, nodeId: string, id: string, mediaType: MediaType, request: MediaGenerationRequest) {
  const existing = read(id);
  if (existing) {
    if (existing.directory !== directoryPath || existing.nodeId !== nodeId || JSON.stringify(existing.request) !== JSON.stringify(request)) throw Object.assign(new Error("任务 ID 已被其他请求使用"), { status: 409 });
    return view(existing);
  }
  const previous = latest(directoryPath, nodeId);
  if (previous && ["queued", "running", "unknown"].includes(previous.status)) return view(previous);
  const now = new Date().toISOString();
  const job: Job = { id, directory: directoryPath, nodeId, mediaType, request, status: "queued", phase: "queued", createdAt: now, updatedAt: now, result: [], logs: [] };
  log(job, "queued", "任务已保存，等待后台处理");
  start(job);
  return view(job);
}
export function getJob(directoryPath: string, nodeId: string, id?: string) {
  const job = id ? read(id) : latest(directoryPath, nodeId);
  if (!job) return null;
  if (job.directory !== directoryPath || job.nodeId !== nodeId) throw Object.assign(new Error("无权访问此节点任务"), { status: 403 });
  if (["queued", "running"].includes(job.status) && !active.has(job.id)) {
    if (job.upstream || job.status === "queued") start(job);
    else {
      job.status = "unknown"; job.error = "服务已重启，尚无已保存的上游任务 ID，无法确认是否提交成功。请先到供应商确认，不能自动重试。";
      log(job, "unknown", job.error);
    }
  }
  return view(job);
}
export function controlJob(directoryPath: string, nodeId: string, id: string, action: "resume" | "cancel") {
  const data = getJob(directoryPath, nodeId, id);
  if (!data) throw Object.assign(new Error("任务不存在"), { status: 404 });
  const job = read(id)!;
  if (action === "resume") {
    if (!job.upstream) throw new Error("没有上游任务 ID，不能自动重新提交");
    if (job.status !== "succeeded") start(job);
  } else if (job.status !== "succeeded") {
    if (active.has(id)) active.get(id)!.controller.abort();
    else { job.status = "cancelled"; log(job, "cancelled", "已停止本地等待；上游任务及费用可能仍在继续"); }
  }
  return view(job);
}
