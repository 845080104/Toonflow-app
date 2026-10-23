import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), nodeId: z.string().min(1).max(256), id: z.uuid(), mediaType: z.enum(["image", "video", "audio"]),
}), async (req, res) => {
  const { directory, nodeId, id, mediaType, ...input } = req.body;
  const request = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema).parse(input);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.json(success(u.mediaJobs.submitJob(cwd, nodeId, id, mediaType, request)));
});
