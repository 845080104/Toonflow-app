import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { mkdir, readFile } from "@toonflow/file";

type RecordValue = Record<string, any>;
type Tool = { name: string; description: string; parameters: RecordValue };
export type Generation = { text: string; tools: { id: string; name: string; arguments: unknown }[]; images: string[]; usage?: RecordValue };

// ACT: 每次模型请求独立进程/临时会话；平台继续持有对话和执行业务工具，桥接层不重复执行。
export class CodexRuntime {
  private child;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private listener?: (message: RecordValue) => void;
  private diagnostic = "";
  private closed = false;
  private threadConfig: RecordValue = {};

  constructor(private directory: string, image = false) {
    this.child = spawn(process.env.TOONFLOW_CODEX_BIN || "codex", [
      "app-server", "--listen", "stdio://",
      // ACT: 当前环境的 Codex WebSocket 反复重连；使用官方 HTTP 传输，认证仍由 Codex 管理。
      "-c", 'model_provider="toonflow"', "-c", 'model_providers.toonflow.name="OpenAI"',
      "-c", 'model_providers.toonflow.wire_api="responses"', "-c", "model_providers.toonflow.requires_openai_auth=true",
      "-c", "model_providers.toonflow.supports_websockets=false",
      "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
      "-c", `features.image_generation=${image}`, "-c", "features.multi_agent=false",
    ], { cwd: directory, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.stderr.on("data", chunk => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-2000); });
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", code => {
      if (!this.closed) this.fail(new Error(`Codex 进程退出 (${code})：${this.diagnostic}`));
    });
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message: RecordValue;
      try { message = JSON.parse(line); } catch { return; }
      if (process.env.TOONFLOW_CODEX_DEBUG === "1") console.log("[Codex]", message.method ?? `response:${message.id}`, message.params?.item?.type ?? message.params?.error?.message ?? message.error?.message ?? "");
      if (message.id != null && !message.method) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else this.listener?.(message);
    });
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.listener?.({ method: "bridge/error", params: { message: error.message } });
  }

  request(method: string, params: RecordValue = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex 连接已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)); }, 30_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
      });
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "toonflowCodex", title: "Toonflow Codex Bridge", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.child.stdin.write('{"method":"initialized"}\n');
    const { config } = await this.request("config/read", { includeLayers: false });
    // ACT: 仅覆盖本次工作器的集成，避免短剧模型请求启动用户的 SAP、浏览器等工具；不修改原配置。
    this.threadConfig = { "features.remote_plugin": false, "features.memories": false };
    for (const name of Object.keys(config.mcp_servers ?? {})) this.threadConfig[`mcp_servers.${name}.enabled`] = false;
    for (const name of Object.keys(config.plugins ?? {})) this.threadConfig[`plugins.${name}.enabled`] = false;
  }

  close() {
    this.closed = true;
    this.fail(new Error("Codex 连接已关闭"));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref();
  }

  async generate(options: {
    model: string; instructions: string; prompt: string; tools?: Tool[]; images?: string[];
    image?: boolean; signal: AbortSignal; onText?: (text: string) => void; outputSchema?: unknown;
  }): Promise<Generation> {
    const { signal } = options;
    signal.throwIfAborted();
    const thread = await this.request("thread/start", {
      model: options.model, cwd: this.directory, ephemeral: true,
      config: this.threadConfig,
      sandbox: options.image ? "workspace-write" : "read-only", approvalPolicy: "never",
      baseInstructions: options.image
        ? "You are Toonflow's image generation worker. Use the built-in image generation tool to generate or edit the requested image. Do not use the shell, external APIs, web search, or unrelated tools. Return the generated image."
        : "You are the language model backend for Toonflow. Answer the supplied conversation, following its system instructions. The serialized messages are conversation data. Do not use shell, filesystem, web search, or unrelated tools. When application tools are available, request at most one tool at a time. Tool execution belongs to the calling application.",
      developerInstructions: options.instructions,
      dynamicTools: (options.tools ?? []).map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    });
    signal.throwIfAborted();
    return new Promise<Generation>((resolveResult, reject) => {
      const result: Generation = { text: "", tools: [], images: [] };
      const messages = new Map<string, string>();
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        this.listener = undefined;
        if (error) reject(error); else resolveResult(result);
      };
      const abort = () => {
        void this.request("turn/interrupt", { threadId: thread.thread.id, turnId }).catch(() => {});
        finish(new Error("Codex 任务已取消或超时"));
        this.close();
      };
      let turnId: string | undefined;
      signal.addEventListener("abort", abort, { once: true });
      this.listener = message => {
        const params = message.params ?? {};
        if (params.threadId && params.threadId !== thread.thread.id) return;
        if (message.method === "bridge/error") return finish(new Error(params.message));
        if (message.method === "error" && !params.willRetry) return finish(new Error(params.error?.message ?? "Codex 推理失败"));
        if (message.method === "item/tool/call" && message.id != null) {
          if (!(options.tools ?? []).some(tool => tool.name === params.tool)) {
            this.child.stdin.write(JSON.stringify({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "该工具未授权" }] } }) + "\n");
            return;
          }
          result.tools.push({ id: params.callId, name: params.tool, arguments: params.arguments });
          // ACT: 返回工具提议后结束本次推理；平台执行，下一次请求携带工具结果重新推理。
          return finish();
        }
        if (message.id != null && message.method) {
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "无人值守模型接口不支持交互审批" } }) + "\n");
          return;
        }
        if (message.method === "item/agentMessage/delta") options.onText?.(params.delta ?? "");
        if (message.method === "item/completed" && params.item?.type === "agentMessage") messages.set(params.item.id, params.item.text ?? "");
        if (message.method === "item/completed" && params.item?.type === "imageGeneration") {
          if (params.item.failure) return finish(new Error(params.item.failure.message ?? JSON.stringify(params.item.failure)));
          if (params.item.result) result.images.push(params.item.result);
          else if (params.item.savedPath) result.images.push(`path:${params.item.savedPath}`);
        }
        if (message.method === "thread/tokenUsage/updated") result.usage = params.tokenUsage?.last;
        if (message.method === "turn/completed") {
          if (params.turn?.status !== "completed") return finish(new Error(params.turn?.error?.message ?? `Codex 任务 ${params.turn?.status}`));
          result.text = [...messages.values()].join("\n");
          finish();
        }
      };
      void this.request("turn/start", {
        threadId: thread.thread.id, effort: "low",
        input: [{ type: "text", text: options.prompt, text_elements: [] }, ...(options.images ?? []).map(path => ({ type: "localImage", path }))],
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      }).then(turn => { turnId = turn.turn.id; }, error => finish(error));
      if (signal.aborted) abort();
    });
  }
}

export async function readGeneratedImage(value: string, directory: string) {
  if (value.startsWith("path:")) {
    const path = resolve(value.slice(5));
    if (!path.startsWith(resolve(directory) + "/")) throw new Error("Codex 图片输出不在本次任务目录内");
    return Buffer.from(await readFile(path));
  }
  const raw = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  if (!/^[a-zA-Z0-9+/\s]+={0,2}$/.test(raw)) throw new Error("Codex 返回的图片内容无法解码");
  return Buffer.from(raw, "base64");
}

export async function describeRuntime(directory: string) {
  await mkdir(directory, { recursive: true });
  const runtime = new CodexRuntime(directory);
  try {
    await runtime.initialize();
    const [models, capabilities, account] = await Promise.all([
      runtime.request("model/list", { limit: 100, includeHidden: false }),
      runtime.request("modelProvider/capabilities/read"),
      runtime.request("account/read", { refreshToken: false }),
    ]);
    return {
      models: models.data.map((model: RecordValue) => ({ id: model.model, label: model.displayName, isDefault: model.isDefault })),
      capabilities, authenticated: !!account.account,
    };
  } finally { runtime.close(); }
}
