import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ fileName: u.mediaProvider.mediaProviderFileSchema, type: z.enum(["text", "image", "video", "audio"]) }), async (req, res) => {
  const info = await u.mediaProvider.getMediaProvider(req.body.fileName.slice(0, -3));
  const configs = u.conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  const provider = await u.mediaProvider.loadMediaProviderSource(info.source, configs?.[info.id] ?? {});
  if (!provider.getModels) throw new Error("此供应商不支持模型目录预览");
  res.json(success(await provider.getModels(req.body.type)));
});
