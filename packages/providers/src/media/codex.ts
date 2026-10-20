const rules = [
  { type: "input", field: "baseUrl" as const, title: "本地连接地址", value: "http://127.0.0.1:4319/v1" },
  { type: "input", field: "apiKey" as const, title: "本地连接凭证", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
];

function delay(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "codex",
  label: "Codex · 图片生成",
  icon: "",
  version: "0.1.0",
  readme: "使用本机 Codex 的内置生图能力，支持角色、场景、分镜和参考图编辑。通过 `bun run start:codex` 自动配置。生图会消耗当前 Codex 账号额度，任务失败不会自动重新生成。",
  rules,
  models: [{ id: "codex-image", label: "Codex Image", type: "image", mode: ["text", "singleImage", "multiReference"], imageRatios: ["1:1", "9:16", "16:9", "2:3", "3:2"] }],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const baseUrl = String(this.config.baseUrl || "http://127.0.0.1:4319/v1").replace(/\/+$/, "");
    const apiKey = String(this.config.apiKey || "").trim();
    if (!apiKey) throw new Error("尚未连接本地 Codex，请使用 start:codex 启动");
    const signal = AbortSignal.any([AbortSignal.timeout(16 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const images = (request.images ?? []).map(image => {
      if (image.type === "url") throw new Error("Codex 参考图片需要先保存到工作区");
      const data = image.type === "binary" ? Buffer.from(image.data).toString("base64") : image.data;
      return data.startsWith("data:") ? data : `data:${image.mimeType || "image/png"};base64,${data}`;
    });
    const created = await this.tool.fetch(`${baseUrl}/images/jobs`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: "codex-image", prompt: request.prompt, images, ratio: request.ratio, size: request.size }),
    });
    const task = await created.json() as { id?: string; error?: { message?: string } };
    if (!created.ok || !task.id) throw new Error(task.error?.message || "无法创建 Codex 图片任务");
    const taskUrl = `${baseUrl}/images/jobs/${encodeURIComponent(task.id)}`;
    try {
      while (true) {
        signal.throwIfAborted();
        const response = await this.tool.fetch(taskUrl, { headers, signal });
        const result = await response.json() as { status?: string; error?: string | { message?: string }; data?: { b64_json: string; mime_type: string }[] };
        if (!response.ok) throw new Error(typeof result.error === "object" ? result.error.message : result.error || "查询 Codex 图片任务失败");
        if (result.status === "completed") {
          if (!result.data?.length) throw new Error("Codex 图片任务完成但没有返回图片");
          return result.data.map(image => ({ mediaType: "image", type: "base64", data: image.b64_json, mimeType: image.mime_type }));
        }
        if (result.status === "failed" || result.status === "cancelled") throw new Error(typeof result.error === "string" ? result.error : "Codex 图片任务已停止");
        await delay(signal);
      }
    } finally {
      if (signal.aborted) await this.tool.fetch(taskUrl, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  },
} satisfies ProviderDefinition<typeof rules>;
