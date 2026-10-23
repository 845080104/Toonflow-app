import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096), nodeId: z.string().min(1).max(256), id: z.uuid().optional(),
}, "query"), async (req, res) => {
  const { directory, nodeId, id } = req.query as { directory: string; nodeId: string; id?: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  res.set("Cache-Control", "no-store").json(success(u.mediaJobs.getJob(cwd, nodeId, id)));
});
