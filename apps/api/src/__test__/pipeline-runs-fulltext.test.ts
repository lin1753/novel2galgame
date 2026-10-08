import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDatabase } from "@novel2gal/storage";
import { createServer } from "../server/server.js";
import { config } from "../config/index.js";
import { getCheckpointManager, resetCheckpointManagerForTests } from "../orchestrator/run-chapter-graph.js";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "../../../../packages/pipeline/src/stages/__test__/fixtures.js";

/**
 * W1 验收 4 — pipeline_runs 全文入库（截断修复回归）。
 *
 * The graph-engine route's terminal-failure handler used to write a generic
 * "Chapter pipeline failed (see retry/failed events)" (or a 500-char slice)
 * into pipeline_runs.error_message — the ch1 lesson: truncated error text hid
 * the zod issue paths. Now: FULL text into the DB (TEXT column), 150-char
 * summary into SSE.
 *
 * E2E: real express server on a tmp dataDir + tmp DB, L0 structure agent
 * (free), ScriptedProvider whose attribution returns a big aliasMap with
 * number values — passes the agent's repair (aliasMap is never normalized
 * there) but fails the stage output schema (z.record(z.string())) with MANY
 * zod issues → the wrapped error carries "Full issues JSON: …" ≫500 chars →
 * queue retries (both attempts fail) → terminal failure → pipeline_runs row
 * must hold the FULL message.
 */

const PORT = 3996;

const NOVEL = `测试小说
作者：测试

第1章 相遇
林晓走进咖啡馆，窗外的雨还没停。她在门口收起伞，抖了抖水珠，环顾四周寻找座位。店里人不多，暖黄的灯光落在原木桌面上，空气里飘着现磨咖啡的香气。她走到柜台前，点了一杯拿铁，然后挑了个靠窗的位置坐下，看着玻璃上蜿蜒而下的雨痕出神。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”他在吧台后忙碌着，蒸汽从咖啡机里升起来，杯碟碰撞发出清脆的声响。不多时，他把拉花精致的拿铁端到她面前，又多放了一块曲奇饼干。
她找了个靠窗的位置坐下，翻开随身带着的书，却一个字也看不进去。窗外雨声淅沥，店里放着舒缓的爵士乐，一切都很安静，只有她的心事在翻涌。这一章就这样过去了，她在这个下午想起了很多从前的事。
`;

/** One garbage aliasMap key per issue → 40 zod issues in one parse. */
const bigBadAliasMap: Record<string, number> = {};
for (let i = 0; i < 40; i++) bigBadAliasMap[`alias_${i}`] = i;

/** Late-wired provider: the chapterId is only known after structure/run,
 * so the inner ScriptedProvider is swapped in just before the chapter run.
 * Before that, any call would throw (no script) — but none happens. */
let innerProvider: ScriptedProvider | null = null;
const lazyProvider = {
  name: "scripted-lazy",
  chat: (options: any) => (innerProvider ?? ({} as any)).chat?.(options) ?? Promise.reject(new Error("no inner provider wired")),
  chatJson: <T,>(options: any): Promise<T> => (innerProvider ?? ({} as any)).chatJson?.(options) ?? Promise.reject(new Error("no inner provider wired")),
} as any;

function wireFailingProvider(chapterId: string): void {
  innerProvider = new ScriptedProvider([
    whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
    // Attribution returns valid units but a garbage aliasMap: the agent
    // merges it verbatim (Object.assign — no validation), then the STAGE
    // output schema z.record(z.string()) throws with one issue per key.
    whenAttribution({ kind: "json", value: { ...FIXTURE_ATTRIBUTION, aliasMap: bigBadAliasMap } }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[`${chapterId}_scene_0001`, `${chapterId}_scene_0002`].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json" as const, value: { ok: true } },
    })),
  ]);
}

let tmpDir: string;
let db: ReturnType<typeof createDatabase>;
let server: any;

function post(pathname: string, body: any, headers: any = { "Content-Type": "application/json" }): Promise<{ status: number; body: any }> {
  const payload: Buffer | string = Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "POST", hostname: "localhost", port: PORT, path: pathname, headers: { ...headers, "Content-Length": payload.length } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function multipart(filename: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----n2gw2" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    "utf-8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  return { body: Buffer.concat([head, content, tail]), boundary };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-w2-trunc-"));
  Object.assign(config, { dataDir: tmpDir, port: PORT });
  db = createDatabase(tmpDir);
  const app = createServer(db, lazyProvider);
  await new Promise<void>((r) => { server = app.listen(PORT, r); });
});

afterAll(() => {
  try { server?.close(); } catch { /* noop */ }
  try { (db as any).close?.(); } catch { /* noop */ }
  // Close the checkpoint manager singleton BEFORE rm (Windows EBUSY guard —
  // same pattern as sse-fake-subscriber.test.ts).
  try { getCheckpointManager(tmpDir).close(); } catch { /* never created */ }
  resetCheckpointManagerForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("W1 验收 4: pipeline_runs 全文入库（无截断）", () => {
  it("chapter failure writes the FULL error message (>500 chars) into pipeline_runs", async () => {
    // 1. create project
    const created = await post("/projects", { title: "W2 truncation test" });
    expect(created.status).toBe(201);
    const projectId = created.body.projectId as string;

    // 2. import novel (multipart)
    const { body, boundary } = multipart("novel.txt", Buffer.from(NOVEL, "utf-8"));
    const imp = await post(`/projects/${projectId}/import`, body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(imp.status).toBe(200);

    // 3. structure (L0 — free, creates chapter rows + source.txt)
    const structured = await post(`/projects/${projectId}/structure/run`, {});
    if (structured.status !== 200) console.log("[structure/run response]", structured.status, structured.body);
    expect(structured.status).toBe(200);
    const chapters = (db.prepare("SELECT chapter_id FROM chapters WHERE project_id = ?").all(projectId) as any[]);
    expect(chapters.length).toBeGreaterThan(0);
    const cid = chapters[0].chapter_id as string;

    // 4. wire the failing provider (before the chapter run — no server
    //    restart needed; the route reads it via the closure getter)
    wireFailingProvider(cid);

    // 5. run the chapter pipeline
    const run = await post(`/projects/${projectId}/chapters/${cid}/run`, {});
    expect(run.status).toBe(200);
    expect(run.body.status).toBe("started");

    // 6. poll pipeline_runs until terminal (2 attempts × ~10s retry delay ≈ 25s)
    const deadline = Date.now() + 60_000;
    let row: any = null;
    while (Date.now() < deadline) {
      row = (db.prepare("SELECT status, error_message FROM pipeline_runs WHERE chapter_id = ?").get(cid) as any);
      if (row && row.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(row).not.toBeNull();
    expect(row.status).toBe("failed");

    // THE assertion: full text in the DB — NOT a 500-char slice, NOT the
    // generic constant. The zod error embeds the full issues JSON (40 issues
    // ≈ 4-5KB), which the old slice(0,500) cut off mid-payload.
    const msg = String(row.error_message ?? "");
    expect(msg.length).toBeGreaterThan(500);
    // The garbage aliasMap keys made it into the persisted detail verbatim
    expect(msg).toContain("aliasMap");
    expect(msg).toContain("invalid_type");
    expect(msg).toContain("alias_39");
    expect(msg).not.toBe("Chapter pipeline failed (see retry/failed events)");
    // W2 bonus: the evidence file path rides the full text (DB reference)
    expect(msg).toContain("parse-failure evidence");
  }, 90_000);
});
