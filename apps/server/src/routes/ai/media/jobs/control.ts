import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), nodeId: z.string().min(1).max(256), id: z.uuid(), action: z.enum(["resume", "cancel"]),
}), async (req, res) => {
  const { directory, nodeId, id, action } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.json(success(u.mediaJobs.controlJob(cwd, nodeId, id, action)));
});
