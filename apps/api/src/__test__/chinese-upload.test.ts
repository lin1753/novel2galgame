import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDatabase } from "@novel2gal/storage";
import { createServer } from "../server/server.js";
import { config } from "../config/index.js";

/**
 * 中文文件名上传测试（验收 B3 后半 + B4）。
 * 起裸 http（3999 风格，端口 3997），手写 multipart（零新依赖），直接测
 * multer originalname latin1 误解码修复 + 入库前乱码检测 + 标题回填。
 */

const PORT = 3997;
let tmpDir: string;
let db: ReturnType<typeof createDatabase>;
let server: ReturnType<http.Server["listen"]> | any;

function multipart(field: string, filenameLatin1: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----n2gtest" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filenameLatin1}"\r\nContent-Type: text/plain\r\n\r\n`,
    "latin1",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "latin1");
  return { body: Buffer.concat([head, content, tail]), boundary };
}

function post(pathname: string, body: Buffer, boundary: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "POST", hostname: "localhost", port: PORT, path: pathname, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } },
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
    req.write(body);
    req.end();
  });
}

function get(pathname: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "localhost", port: PORT, path: pathname }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    }).on("error", reject);
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-upload-test-"));
  Object.assign(config, { dataDir: tmpDir, port: PORT });
  db = createDatabase(tmpDir);
  const app = createServer(db, null);
  await new Promise<void>((r) => { server = app.listen(PORT, r); });
});

afterAll(() => {
  try { server?.close(); } catch { /* noop */ }
  try { (db as any).close?.(); } catch { /* noop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("中文文件名上传（multer latin1 修复 + 标题回填）", () => {
  it("中文文件名经 latin1 传输后 sourceFileName 干净 + 标题回填", async () => {
    const realName = "《利己主义》作者：枯寒.txt";
    // 模拟 multer/busboy 行为：UTF-8 字节以 latin1 字符写入 multipart filename 段
    const latin1Name = Buffer.from(realName, "utf-8").toString("latin1");
    const content = Buffer.from("《利己主义》作者：枯寒\n\n第1章 测试内容在此，足够长的正文段落。\n\n第2章 第二章内容。\n", "utf-8");

    const created = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { method: "POST", hostname: "localhost", port: PORT, path: "/projects", headers: { "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ title: "Untitled" }));
      req.end();
    });
    expect(created.status).toBe(201);
    const projectId = created.body.projectId as string;

    const { body, boundary } = multipart("file", latin1Name, content);
    const imp = await post(`/projects/${projectId}/import`, body, boundary);
    expect(imp.status).toBe(200);
    expect(imp.body.encodingWarning ?? []).toEqual([]);

    const got = await get(`/projects/${projectId}`);
    expect(got.status).toBe(200);
    expect(got.body.sourceFileName).toBe(realName);
    expect(got.body.sourceFileName.includes("�")).toBe(false);
    // 标题优先级第三级：Untitled → 文件名去扩展名回填
    expect(got.body.title).toBe("《利己主义》作者：枯寒");
  });
});
