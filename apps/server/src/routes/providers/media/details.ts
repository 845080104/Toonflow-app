import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/), modelId: z.string().min(1).max(256) }), async (req, res) => {
  const info = await u.mediaProvider.getMediaProvider(req.body.providerId);
  const configs = u.conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  const provider = await u.mediaProvider.loadMediaProviderSource(info.source, configs?.[info.id] ?? {});
  if (!provider.getModelDetails) throw new Error("此供应商不支持模型价格查询");
  res.json(success(await provider.getModelDetails(req.body.modelId)));
});
