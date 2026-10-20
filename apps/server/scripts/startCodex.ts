import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, mkdir, readFile, writeAtomic } from "@toonflow/file";
import { startCodexBridge } from "@toonflow/codex-bridge";
import config from "../../../electrobun.config";

const root = resolve(import.meta.dirname, "../../..");
const dataDirectory = resolve(process.env.TOONFLOW_DATA_DIR || resolve(root, "data"));
const bridgeDirectory = resolve(dataDirectory, "codexBridge");
await mkdir(bridgeDirectory, { recursive: true });
const connectionPath = resolve(bridgeDirectory, "connection.json");
const connection = existsSync(connectionPath)
  ? JSON.parse(await readFile(connectionPath, "utf8")) as { token: string }
  : { token: randomBytes(32).toString("hex") };
await writeAtomic(connectionPath, JSON.stringify(connection), { mode: 0o600 });
const bridgePort = Number(process.env.TOONFLOW_CODEX_PORT || 4319);
const port = Number(process.env.TOONFLOW_PORT || 3000);
if (![bridgePort, port].every(value => Number.isInteger(value) && value > 0 && value <= 65535) || bridgePort === port) throw new Error("服务端口无效或冲突");
const bridge = await startCodexBridge({ directory: bridgeDirectory, token: connection.token, port: bridgePort });
process.env.TOONFLOW_DATA_DIR = dataDirectory;
process.env.NODE_ENV = "production";
try {
  const { default: conf } = await import("../src/utils/conf");
  const settings = conf.get("settings", {});
  const providers = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  const apiUrl = `http://127.0.0.1:${bridgePort}/v1`;
  const codex = {
    id: "codex", label: "Codex · 本机", version: "0.1.0", apiUrl,
    apiKey: connection.token, protocol: "openai-completions",
    models: bridge.description.models.map((model: { id: string; label: string }) => ({ id: model.id, label: `Codex · ${model.label}` })),
  };
  // ACT: 本启动模式只维护 Codex 供应商，保留原有的供应商、项目与界面配置。
  conf.set("settings", {
    ...settings, customProviders: [codex, ...providers.filter(item => item?.id !== "codex")],
    mediaProviderConfigs: { ...(settings.mediaProviderConfigs as object ?? {}), codex: { baseUrl: apiUrl, apiKey: connection.token } },
  });
  const { createApp } = await import("../src/app");
  const app = await createApp({
    webRoot: resolve(root, "build/web"), appVersion: config.app.version, dataDirectory,
    toolsRoot: resolve(root, "build/tools"), nodesRoot: resolve(root, "build/nodes"),
    extRoot: resolve(root, "build/ext"), providersRoot: resolve(root, "packages/providers/src"), skillsRoot: resolve(root, "packages/skills"),
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolveReady, reject) => { server.once("listening", resolveReady); server.once("error", reject); });
  const { initializeMcpRuntime } = await import("../src/utils/mcp/runtime");
  const { startMobileLinkRuntime } = await import("../src/utils/mobileLink");
  await initializeMcpRuntime(app, `http://127.0.0.1:${port}`, resolve(root, "packages/mcp/src/stdio.ts"));
  await startMobileLinkRuntime(app);
  console.log(`Toonflow: http://127.0.0.1:${port}`);
  console.log(`Codex 中间层: http://127.0.0.1:${bridgePort}；默认模型: ${bridge.defaultModel}；生图: ${bridge.description.capabilities.imageGeneration ? "可用" : "不可用"}`);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true; bridge.close(); server.close();
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
} catch (error) { bridge.close(); throw error; }
