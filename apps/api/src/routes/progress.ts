import { Router } from "express";
import type { Request, Response } from "express";

export type ProgressStatus = "started" | "progress" | "completed" | "failed" | "cancelled";

export type ProgressEvent = {
  projectId: string;
  chapterId?: string;
  chapterIndex?: number;
  sceneId?: string;
  stage: string;
  status: ProgressStatus;
  message?: string;
  data?: unknown;
};

// projectId -> SSE connections
const connections = new Map<string, Set<Response>>();

export function broadcastProgress(event: ProgressEvent) {
  const conns = connections.get(event.projectId);
  if (!conns) return;
  const data = JSON.stringify(event);
  for (const res of conns) {
    res.write(`data: ${data}\n\n`);
  }
}

export function createProgressRoutes() {
  const router = Router();

  // GET /projects/:id/progress - SSE stream
  router.get("/projects/:id/progress", (req: Request, res: Response) => {
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ projectId, status: "connected" })}\n\n`);

    if (!connections.has(projectId)) connections.set(projectId, new Set());
    connections.get(projectId)!.add(res);

    req.on("close", () => {
      connections.get(projectId)?.delete(res);
      if (connections.get(projectId)?.size === 0) connections.delete(projectId);
    });
  });

  return router;
}

export { connections };
