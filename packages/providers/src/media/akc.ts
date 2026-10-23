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


type AkcParameter = { name: string; label?: string; type: string; required?: boolean; description?: string; available_when?: Record<string, (string | number | boolean)[]>; applies_to_mode?: string[]; options?: { value: string | number | boolean; label?: string; currently_unavailable?: boolean }[] };
type AkcModel = { name: string; display_name?: string; type: ModelType; description?: string; input_hint?: string; tags?: string[]; icon?: string; available_for_this_key?: boolean; params?: AkcParameter[]; api_format?: string; api_endpoints?: { format: string; endpoint: string }[] };
type AkcContext = ProviderContext<{ apiKey: string; baseUrl: string }>;

async function json(context: AkcContext, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const key = context.config.apiKey.trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请先填写智核 API Key");
  const baseUrl = (context.config.baseUrl.trim() || "https://api.lk888.ai").replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请填写有效的 API 基础地址");
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof data.code === "number" && data.code !== 200) throw new Error(context.tool.errorMessage(data) || `智核接口失败（HTTP ${response.status}）`);
  return data;
}
function modelPath(name: string) { return name.split("/").map(encodeURIComponent).join("/"); }
function modelInfo(model: AkcModel): ProviderModel {
  const parameters = model.params ?? [];
  const values = (names: string[]) => parameters.find(p => names.includes(p.name))?.options?.map(option => String(option.value)) ?? [];
  const durations = values(["duration"]).map(Number).filter(value => Number.isFinite(value) && value > 0);
  const resolutions = values(["resolution"]);
  const imageField = parameters.some(p => p.type === "upload" && ["images", "image_url", "image", "img_url"].includes(p.name));
  const referenceMode: VideoMode = [
    ...(imageField ? ["imageReference:9" as const] : []),
    ...(parameters.some(p => p.name === "video_url") ? ["videoReference:3" as const] : []),
    ...(parameters.some(p => p.name === "audio_url") ? ["audioReference:3" as const] : []),
  ];
  return {
    id: model.name, label: model.display_name || model.name, type: model.type,
    description: model.description || "", tags: model.tags ?? [], icon: model.icon || "",
    available: model.available_for_this_key !== false && (model.type !== "text" || ["openai", "openai_responses", "anthropic"].includes(model.api_format ?? "")), parameters,
    ...(model.type === "text" ? { languageProtocol: model.api_format === "anthropic" ? "anthropic-messages" : model.api_format === "openai_responses" ? "openai-responses" : model.api_format === "openai" ? "openai-completions" : "unsupported", tags: [...(model.tags ?? []), `${model.api_format || "未知"} 协议`] } : {}),
    ...(model.type === "image" ? { mode: ["text", "singleImage", "multiReference"], imageSizes: values(["resolution", "imageSize", "size"]), imageRatios: values(["aspect_ratio", "aspectRatio", "ratio"]).filter(value => /^\d+:\d+$/.test(value)) } : {}),
    ...(model.type === "video" ? {
      // ACT: 素材上限由平台按模型校验；这里的通用模式仅控制画布接线，不代替实际参数校验。
      mode: ["text", ...(referenceMode.length ? [referenceMode] : []), ...(model.name === "minimax-h3" ? ["endFrameOptional" as const] : [])],
      durationResolutionMap: durations.length && resolutions.length ? [{ duration: durations, resolution: resolutions }] : [],
    } : {}),
  };
}
async function generate(context: AkcContext, type: "image" | "video" | "audio", request: ImageRequest | VideoRequest | AudioRequest): Promise<MediaAsset[]> {
  let taskId = context.tool.task?.upstream?.id;
  if (context.tool.task?.upstream && context.tool.task.upstream.protocol !== "akcMedia") throw new Error("保存任务的协议不匹配，不能重新提交");
  if (!taskId) {
    const detail = await json(context, `/v1/skills/models/${modelPath(request.model)}`) as unknown as AkcModel;
    if (detail.type !== type) throw new Error("所选模型类型不匹配，请重新获取同类模型");
    if (detail.available_for_this_key === false) throw new Error("此 API Key 尚未开通该模型的渠道，请到智核密钥管理配置");
    const parameters = detail.params ?? [];
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.other ?? {})) {
      if (!parameters.some(p => p.name === key)) throw new Error(`模型不支持参数：${key}`);
      if (value !== "" && value !== null) params[key] = value;
    }
    const set = (names: string[], value: unknown) => {
      const field = parameters.find(p => names.includes(p.name));
      if (field && params[field.name] === undefined && value !== undefined && value !== "") params[field.name] = value;
    };
    let totalBytes = 0;
    function inputUrl(input: MediaInput) {
      if (input.type === "url") return mediaUrl(input);
      const value = mediaUrl(input);
      const size = Buffer.from(value.slice(value.indexOf(",") + 1), "base64").length;
      if (size > 10 * 1024 * 1024) throw new Error("统一媒体接口单张图片或音频最多 10 MB");
      totalBytes += size;
      if (totalBytes > 30 * 1024 * 1024) throw new Error("单次内联参考素材合计不能超过 30 MB");
      return value;
    }
    const imageRequest = request as ImageRequest;
    const videoRequest = request as VideoRequest;
    const audioRequest = request as AudioRequest;
    const frames = [videoRequest.firstFrame, videoRequest.lastFrame].filter((input): input is MediaInput => !!input);
    if (frames.length && (request.images?.length || videoRequest.videos?.length || videoRequest.audios?.length)) throw new Error("首尾帧不能与其他参考素材混用");
    if (videoRequest.videos?.some(input => input.type !== "url")) throw new Error("此站的视频参考需公网 URL，请在模型参数里填写视频直链");
    if (frames.length) { set(["mode"], "shouweizhen"); set(["images"], frames.map(inputUrl)); }
    else if (request.images?.length) {
      const field = parameters.find(p => p.type === "upload" && ["images", "image_url", "image", "img_url"].includes(p.name));
      if (!field) throw new Error("此模型不支持图片引用");
      set([field.name], field.name === "images" || field.name === "image_url" ? request.images.map(inputUrl) : inputUrl(request.images[0]!));
      if (request.model === "minimax-h3") set(["mode"], "cankaosheng");
    }
    if (videoRequest.audios?.length) set(["audio_url", "audios", "sound_file"], videoRequest.audios!.map(inputUrl));
    if (videoRequest.videos?.length) set(["video_url", "videos"], videoRequest.videos.map(inputUrl));
    set(["aspect_ratio", "aspectRatio", "ratio"], videoRequest.ratio);
    if (type === "video") { set(["duration"], videoRequest.duration === undefined ? undefined : String(videoRequest.duration)); set(["resolution"], videoRequest.resolution); set(["audio", "generate_audio"], videoRequest.generateAudio); }
    if (type === "image") set(["resolution", "imageSize", "size"], imageRequest.size);
    if (type === "audio") { set(["voice_id", "voice"], audioRequest.voice); set(["speed", "speech_rate"], audioRequest.speed); set(["format"], audioRequest.format); set(["sample_rate"], audioRequest.sampleRate); }
    for (const p of parameters) {
      if (p.name === "prompt") continue;
      const applicable = !p.available_when || Object.entries(p.available_when).every(([key, values]) => values.some(value => String(value) === String(params[key])));
      if (!applicable) { delete params[p.name]; continue; }
      let value = params[p.name];
      if (p.type === "upload" && typeof value === "string" && value.trim()) {
        const urls = value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (urls.some(url => !/^https?:\/\//i.test(url))) throw new Error(`${p.label || p.name}须填写公网 HTTP(S) 直链`);
        value = params[p.name] = ["images", "videos", "audios", "clips", "files", "attachments", "reference_urls"].includes(p.name) ? urls : urls.length === 1 ? urls[0] : urls;
      }
      if (p.required && (value === undefined || value === "" || Array.isArray(value) && !value.length)) throw new Error(`请填写模型参数：${p.label || p.name}`);
      if (value !== undefined && p.options?.length) {
        const option = p.options.find(option => String(option.value) === String(value));
        if (!option || option.currently_unavailable) throw new Error(`${p.label || p.name}不支持所选值，请重新获取模型并调整参数`);
        params[p.name] = option.value;
      }
    }
    context.tool.task?.log("submitting", "向智核提交生成任务（只提交一次）");
    const created = await json(context, "/v1/media/generate", { model: request.model, prompt: "text" in request ? request.text : request.prompt, params });
    const id = (created.data as { task_id?: unknown } | undefined)?.task_id ?? created.task_id;
    if (typeof id !== "string" && typeof id !== "number" || !String(id)) throw new Error("未返回任务 ID，请到智核确认提交结果，避免重复生成");
    taskId = String(id);
    context.tool.task?.save({ id: taskId, protocol: "akcMedia" });
  }
  const signal = context.signal ?? AbortSignal.timeout(30 * 60_000);
  while (true) {
    signal.throwIfAborted();
    const result = await json(context, `/v1/skills/task-status?task_id=${encodeURIComponent(taskId)}`);
    context.tool.task?.log("polling", `智核状态：${String(result.status || result.state || "等待中")}${result.progress ? ` · ${result.progress}%` : ""}`);
    if (result.is_final === true) {
      if (result.state !== "success") throw new Error(context.tool.errorMessage(result.error) || String(result.status || "智核任务失败"));
      const urls = Array.isArray(result.result_urls) ? result.result_urls : result.result_url ? [result.result_url] : [];
      if (!urls.length || urls.some(url => typeof url !== "string" || !/^https?:\/\//i.test(url))) throw new Error("任务已完成但没有可下载结果，请保留任务 ID 查询");
      if (typeof result.cost === "number" && Number.isFinite(result.cost)) context.tool.task?.log("polling", `智核实际消耗：${result.cost} 算力`);
      return urls.map(url => ({ type: "url", mediaType: type, url: String(url) }));
    }
    await wait(signal);
  }
}
async function generateH3(this: ProviderContext<{ apiKey: string; baseUrl: string }>, request: VideoRequest): Promise<MediaAsset[]> {
  const apiKey = this.config.apiKey.trim();
  if (!apiKey) throw new Error("请先在设置 → 媒体模型 → 智核AI超市填写 API Key");
  const baseUrl = (this.config.baseUrl.trim() || "https://api.lk888.ai").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 地址须使用 HTTP 或 HTTPS");
  let content: Record<string, unknown>[] = [];
  let ratio = request.ratio ?? "9:16";
  if (!this.tool.task?.upstream) {
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

    if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("H3 不支持所选宽高比");
    content = [{ type: "text", text: request.prompt }];
    if (request.firstFrame) content.push({ type: "image_url", role: "first_frame", image_url: { url: mediaUrl(request.firstFrame) } });
    if (request.lastFrame) content.push({ type: "image_url", role: "last_frame", image_url: { url: mediaUrl(request.lastFrame) } });
    images.forEach(image => content.push({ type: "image_url", role: "reference_image", image_url: { url: mediaUrl(image) } }));
    audios.forEach(audio => content.push({ type: "audio_url", role: "reference_audio", audio_url: { url: mediaUrl(audio) } }));
  }
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  let taskId = this.tool.task?.upstream?.id;
  if (!taskId) {
    this.tool.task?.log("submitting", "提交 H3 任务（只提交一次）");
    const response = await this.tool.fetch(`${baseUrl}/v2/video_generation`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: request.model, content, duration: request.duration, resolution: request.resolution, ratio: request.firstFrame ? "adaptive" : ratio }),
    });
    const created = await response.json() as { task_id?: string; error?: unknown };
    if (!response.ok) throw new Error(this.tool.errorMessage(created) || `提交 H3 任务失败：HTTP ${response.status}`);
    if (typeof created.task_id !== "string" || !/^\d+$/.test(created.task_id)) throw new Error("H3 未返回有效任务 ID，请先到网站确认是否已创建任务");
    taskId = created.task_id;
    this.tool.task?.save({ id: taskId, protocol: "minimax" });
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const polled = await this.tool.fetch(`${baseUrl}/v2/query/video_generation/${taskId}`, { headers, signal });
      const result = await polled.json() as { task?: { status?: string; content?: { url?: string }; error?: unknown } };
      if (!polled.ok) throw new Error(this.tool.errorMessage(result) || `查询 H3 任务失败：HTTP ${polled.status}`);
      const task = result.task;
      this.tool.task?.log("polling", `H3 上游状态：${task?.status ?? "未知"}`);
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
}
export default {
  id: "akc", label: "智核AI超市", icon: "", version: "0.2.0",
  modelsUrl: "https://api.lk888.ai/v1/skills/models",
  readme: "配置智核 API Key 后点击获取模型，按视频、图片或音频分类勾选导入。模型标签、参数与价格直接从智核查询；价格单位为算力，渠道和档位会影响实际费用。统一媒体协议自动处理不同模型参数，原 MiniMax-H3 保留原生协议兼容。任务 ID 与状态由服务端保存，刷新只恢复查询，不重新提交。视频引用须公网 URL，图片/音频支持内联。",
  rules,
  models: [{ id: "MiniMax-H3", label: "MiniMax H3（原生兼容）", type: "video", audio: true,
    mode: ["text", "endFrameOptional", ["imageReference:9", "audioReference:3"]],
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "1080P", "2K", "4K"] }],
  }],
  async getModels(type?: ModelType) {
    const requested = type ?? "video";
    const [catalog, media] = await Promise.all([
      json(this, `/v1/skills/models?type=${requested === "text" ? "chat" : requested}`),
      requested === "text" ? Promise.resolve({ models: [] }) : json(this, `/v1/media/models?type=${requested}`),
    ]);
    const items = catalog.models as AkcModel[];
    if (!Array.isArray(items)) throw new Error("智核模型目录格式错误");
    const definitions = media.models as AkcModel[];
    return items.filter(item => item.type === requested || requested === "text" && String(item.type) === "chat").map(item => modelInfo({ ...item, type: requested, params: definitions.find(model => model.name === item.name)?.params ?? [] }));
  },
  async getModelDetails(model: string) {
    const name = model === "MiniMax-H3" ? "minimax-h3" : model;
    const [detail, pricing] = await Promise.all([json(this, `/v1/skills/models/${modelPath(name)}`), json(this, `/v1/skills/models/${modelPath(name)}/pricing`)]);
    return { ...modelInfo({ ...(detail as unknown as AkcModel), type: detail.type === "chat" ? "text" : detail.type as ModelType }), pricing, fetchedAt: new Date().toISOString() };
  },
  generateVideo(request: VideoRequest) {
    if (this.tool.task?.upstream?.protocol === "minimax" || request.model === "MiniMax-H3" && !this.tool.task?.upstream && !Object.keys(request.other ?? {}).length) return generateH3.call(this, request);
    return generate(this, "video", { ...request, model: request.model === "MiniMax-H3" ? "minimax-h3" : request.model });
  },
  generateImage(request: ImageRequest) { return generate(this, "image", request); },
  generateAudio(request: AudioRequest) { return generate(this, "audio", request); },
} satisfies ProviderDefinition<typeof rules>;
