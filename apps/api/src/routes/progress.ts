import { Router } from "express";
import type { Request, Response } from "express";

export type ProgressStatus = "started" | "progress" | "completed" | "failed" | "cancelled";

export type ProgressEvent = {
  projectId: string;
  chapterId?: string;
  chapterIndex?: number;
  sceneId?: string;
  sceneIndex?: number;
  sceneCount?: number;
  stage: string;
  status: ProgressStatus;
  message?: string;
  data?: unknown;
  // Stage-3 Phase 4: chapter run stats — present on `completed` data only
  // (queue fan-out copies these into `data` at the broadcast sites).
  // ChapterProgressEvent in task-queue.ts is the typed source; these stay
  // optional here so old consumers never break.
  stagesRun?: number;
  stagesCached?: number;
  stagesDegraded?: number;
  tokens?: { prompt: number; completion: number };
};

// projectId -> SSE connections
const connections = new Map<string, Set<Response>>();

export function broadcastProgress(event: ProgressEvent) {
  const conns = connections.get(event.projectId);
  if (!conns) return;
  const data = JSON.stringify(event);
  for (const res of conns) {
    res.write(`data: ${data}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();
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
      "X-Accel-Buffering": "no"
    });
    res.write(`data: ${JSON.stringify({ projectId, status: "connected" })}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();

    if (!connections.has(projectId)) connections.set(projectId, new Set());
    connections.get(projectId)!.add(res);

    // 20s heartbeat (acceptance item 2): without traffic, a 5-min proxy/agent
    // idle timeout would sever a live pipeline stream; a ping every 20s keeps
    // every hop from treating it as dead. Comment lines (":\n\n") are SSE
    // keep-alives invisible to EventSource consumers.
    const pingInterval = setInterval(() => {
      res.write(":\n\n");
      if (typeof (res as any).flush === 'function') (res as any).flush();
    }, 20_000);

    req.on("close", () => {
      clearInterval(pingInterval);
      connections.get(projectId)?.delete(res);
      if (connections.get(projectId)?.size === 0) connections.delete(projectId);
    });
  });

  return router;
}

export { connections };
