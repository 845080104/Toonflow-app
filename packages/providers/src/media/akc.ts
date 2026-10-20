const rules = [
  { type: "input", field: "apiKey" as const, title: "智核 API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "API 地址", value: "https://api.lk888.ai" },
];

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考素材须使用 HTTP 或 HTTPS 地址");
    return input.url;
  }
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  const content = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (Buffer.from(content, "base64").length > 20 * 1024 * 1024) throw new Error("单张参考图或参考音频不能超过 20 MB");
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "akc",
  label: "智核AI超市",
  icon: "",
  version: "0.1.0",
  readme: "接入 [智核AI超市 MiniMax H3](https://akc.kk0606.com/apidoc#model/minimax-h3)。请填写该站点的 API Key；API 地址已按文档预填。支持文生、首帧/首尾帧、最多 9 张参考图及 3 段参考音频，4～15 秒，768P/1080P/2K/4K，有声视频。参考图最小边 300 像素，图片或音频单文件最多 20 MB，参考音频总时长最多 15 秒。该站视频参考仅支持公网 URL，当前画布提供本地文件，因此暂不开放视频参考。创建任务即计费，不自动重试；停止等待不会取消上游已创建的任务，请到网站查询结果后再决定是否重试。",
  rules,
  models: [{
    id: "MiniMax-H3", label: "MiniMax H3", type: "video", audio: true,
    mode: ["text", "endFrameOptional", ["imageReference:9", "audioReference:3"]],
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "1080P", "2K", "4K"] }],
  }],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey.trim();
    if (!apiKey) throw new Error("请先在设置 → 媒体模型 → 智核AI超市填写 API Key");
    const baseUrl = (this.config.baseUrl.trim() || "https://api.lk888.ai").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 地址须使用 HTTP 或 HTTPS");
    if (request.model !== "MiniMax-H3") throw new Error("此适配当前只接入 MiniMax-H3");
    if (!request.prompt.trim() || request.prompt.length > 7000) throw new Error("H3 提示词须为 1～7000 字");
    if (!Number.isInteger(request.duration) || request.duration! < 4 || request.duration! > 15) throw new Error("H3 时长须为 4～15 的整数秒");
    if (!["768P", "1080P", "2K", "4K"].includes(request.resolution ?? "")) throw new Error("请选择 768P、1080P、2K 或 4K 分辨率");
    if (request.generateAudio === false) throw new Error("此站 H3 生成有声视频，不支持关闭声音");
    if ((request.videos ?? []).length) throw new Error("该站 H3 视频参考要求公网 URL，当前适配暂不支持本地视频参考");
    const images = request.images ?? [];
    const audios = request.audios ?? [];
    if (images.length > 9 || audios.length > 3) throw new Error("最多支持 9 张参考图和 3 段参考音频");
    if (request.lastFrame && !request.firstFrame) throw new Error("H3 尾帧须与首帧同时提供");
    if ((request.firstFrame || request.lastFrame) && (images.length || audios.length)) throw new Error("首尾帧不能与参考图或参考音频混用");
    const ratio = request.ratio ?? "9:16";
    if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("H3 不支持所选宽高比");
    const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
    if (request.firstFrame) content.push({ type: "image_url", role: "first_frame", image_url: { url: mediaUrl(request.firstFrame) } });
    if (request.lastFrame) content.push({ type: "image_url", role: "last_frame", image_url: { url: mediaUrl(request.lastFrame) } });
    images.forEach(image => content.push({ type: "image_url", role: "reference_image", image_url: { url: mediaUrl(image) } }));
    audios.forEach(audio => content.push({ type: "audio_url", role: "reference_audio", audio_url: { url: mediaUrl(audio) } }));
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const response = await this.tool.fetch(`${baseUrl}/v2/video_generation`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: request.model, content, duration: request.duration, resolution: request.resolution, ratio: request.firstFrame ? "adaptive" : ratio }),
    });
    const created = await response.json() as { task_id?: string; error?: unknown };
    if (!response.ok) throw new Error(this.tool.errorMessage(created) || `提交 H3 任务失败：HTTP ${response.status}`);
    if (typeof created.task_id !== "string" || !/^\d+$/.test(created.task_id)) throw new Error("H3 未返回有效任务 ID，请先到网站确认是否已创建任务");
    const taskId = created.task_id;
    try {
      while (true) {
        signal.throwIfAborted();
        const polled = await this.tool.fetch(`${baseUrl}/v2/query/video_generation/${taskId}`, { headers, signal });
        const result = await polled.json() as { task?: { status?: string; content?: { url?: string }; error?: unknown } };
        if (!polled.ok) throw new Error(this.tool.errorMessage(result) || `查询 H3 任务失败：HTTP ${polled.status}`);
        const task = result.task;
        if (task?.status === "succeeded") {
          if (!task.content?.url || !/^https?:\/\//i.test(task.content.url)) throw new Error("H3 任务完成但未返回有效视频地址");
          return [{ mediaType: "video", type: "url", url: task.content.url }];
        }
        if (task?.status === "failed" || task?.status === "cancelled") throw new Error(this.tool.errorMessage(task.error) || `H3 任务已${task.status === "failed" ? "失败" : "取消"}`);
        if (task?.status !== "queued" && task?.status !== "running") throw new Error("H3 返回了无法识别的任务状态");
        await wait(signal);
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "H3 查询已停止"}（任务 ${taskId}，请到网站确认结果，避免重复提交）`);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
