import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ models: z.array(z.string().min(1).max(200)).min(1).max(200) }), async (req, res) => {
  const info = await u.mediaProvider.getMediaProvider("akc");
  const settings = u.conf.get("settings", {});
  const config = (settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined)?.akc ?? {};
  const key = u.mediaProvider.getMediaProviderApiKey("akc");
  if (!key) throw new Error("请先配置智核 API Key");
  const provider = await u.mediaProvider.loadMediaProviderSource(info.source, config);
  if (!provider.getModels) throw new Error("请先更新智核适配器");
  const catalog = await provider.getModels("text");
  const selected = (req.body.models as string[]).map((id: string) => {
    const model = catalog.find(item => item.id === id);
    if (!model || model.available === false || !model.languageProtocol || model.languageProtocol === "unsupported") throw new Error(`此语言模型尚不可用：${id}`);
    return model;
  });
  // ACT: 查询后重新读取完整设置，保留期间发生的其他设置修改；密钥/地址变化则拒绝保存。
  const current = u.conf.get("settings", {});
  const currentConfig = (current.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined)?.akc ?? {};
  if (u.mediaProvider.getMediaProviderApiKey("akc") !== key || currentConfig.baseUrl !== config.baseUrl) throw Object.assign(new Error("智核连接配置已变更，请重新获取模型"), { status: 409 });
  const providers: Record<string, unknown>[] = [];
  for (const [protocol, id, label] of [["openai-completions", "akcChat", "智核 · 语言"], ["openai-responses", "akcResponses", "智核 · Responses"], ["anthropic-messages", "akcMessages", "智核 · Anthropic"]] as const) {
    const models = selected.filter(model => model.languageProtocol === protocol).map(model => ({ id: model.id, label: model.label }));
    if (!models.length) continue;
    const imported = { id, label, version: "0.2.0", apiUrl: `${String(config.baseUrl || "https://api.lk888.ai").replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`, apiKey: key, protocol,
      models };
    providers.push(imported);
  }
  // ACT: 返回待保存变更，由前端既有设置保存队列合并，避免后台写入与页面完整快照互相覆盖。
  res.json(success({ providers }));
});
