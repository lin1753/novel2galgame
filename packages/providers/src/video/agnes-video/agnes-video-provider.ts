import https from "node:https";
import type {
  VideoProvider,
  VideoGenerationRequest,
  VideoGenerationTask,
  VideoGenerationStatus,
} from "../interfaces.js";

export interface AgnesVideoProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export class AgnesVideoProvider implements VideoProvider {
  readonly name = "agnes-video";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: AgnesVideoProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  }

  async createTask(request: VideoGenerationRequest): Promise<VideoGenerationTask> {
    const model = request.model ?? "agnes-video-v2.0";
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      height: request.height ?? 768,
      width: request.width ?? 1152,
      num_frames: request.numFrames ?? 121,
      frame_rate: request.frameRate ?? 24,
    };

    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (request.seed != null) body.seed = request.seed;
    if (request.inferenceSteps != null) body.num_inference_steps = request.inferenceSteps;

    // Image-to-video (single image)
    if (request.imageUrl) {
      body.image = request.imageUrl;
    }

    // Multi-image or keyframe mode
    if (request.imageUrls?.length) {
      body.extra_body = { image: request.imageUrls };
      if (request.mode) (body.extra_body as Record<string, unknown>).mode = request.mode;
    } else if (request.mode) {
      body.mode = request.mode;
    }

    const data = await this.post("/v1/videos", body);
    return {
      taskId: data.task_id ?? data.id,
      videoId: data.video_id ?? "",
      status: (data.status as VideoGenerationStatus) ?? "queued",
      progress: data.progress ?? 0,
      request,
      seconds: data.seconds,
      size: data.size,
      createdAt: new Date().toISOString(),
    };
  }

  async checkTaskStatus(taskId: string): Promise<VideoGenerationTask> {
    const data = await this.get(`/v1/videos/${taskId}`);
    return {
      taskId: data.task_id ?? data.id ?? taskId,
      videoId: data.video_id ?? "",
      status: (data.status as VideoGenerationStatus) ?? "queued",
      progress: data.progress ?? 0,
      request: { prompt: "" },
      videoUrl: data.remixed_from_video_id ?? undefined,
      seconds: data.seconds,
      size: data.size,
      createdAt: new Date((data.created_at ?? 0) * 1000).toISOString(),
      completedAt: data.status === "completed" ? new Date().toISOString() : undefined,
    };
  }

  /** Poll until completed or failed, with configurable interval and timeout. */
  async waitForCompletion(
    taskId: string,
    opts?: { intervalMs?: number; timeoutMs?: number }
  ): Promise<VideoGenerationTask> {
    const interval = opts?.intervalMs ?? 10_000;
    const timeout = opts?.timeoutMs ?? 600_000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const task = await this.checkTaskStatus(taskId);
      if (task.status === "completed" || task.status === "failed") return task;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Video task ${taskId} timed out after ${timeout}ms`);
  }

  getSupportedModels(): string[] {
    return ["agnes-video-v2.0"];
  }

  getDefaultSize(): { width: number; height: number } {
    return { width: 1152, height: 768 };
  }

  private async post(path: string, body: object): Promise<any> {
    return this.request("POST", path, JSON.stringify(body));
  }

  private async get(path: string): Promise<any> {
    return this.request("GET", path);
  }

  private request(method: string, path: string, body?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      }, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(responseBody)); }
            catch { reject(new Error(`Failed to parse response: ${responseBody.slice(0, 200)}`)); }
          } else {
            reject(new Error(`Agnes Video API ${res.statusCode}: ${responseBody.slice(0, 500)}`));
          }
        });
      });
      req.on("error", (e) => reject(new Error(`Request failed: ${e.message}`)));
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error("Request timeout")); });
      if (body) req.write(body);
      req.end();
    });
  }
}
