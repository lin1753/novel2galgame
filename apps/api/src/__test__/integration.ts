import { createDatabase } from "@novel2gal/storage";
import { createServer } from "../server/server.js";
import { config } from "../config/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const TEST_PORT = 3999;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "novel2gal-api-test-"));

// Override config for test
Object.assign(config, { dataDir: tmpDir, port: TEST_PORT });

const db = createDatabase(tmpDir);
const app = createServer(db, null);
const server = app.listen(TEST_PORT);

const BASE = `http://localhost:${TEST_PORT}`;

async function request(method: string, path: string, body?: unknown) {
  const opts: http.RequestOptions = {
    method,
    hostname: "localhost",
    port: TEST_PORT,
    path,
    headers: { "Content-Type": "application/json" },
  };
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log("=== Integration Test ===\n");

  // Test 1: Health check
  const health = await request("GET", "/health");
  console.log(`1. Health: status=${health.status}, body=${JSON.stringify(health.body)}`);
  console.assert(health.status === 200, "Health check failed");

  // Test 2: Create project
  const created = await request("POST", "/projects", { title: "测试小说" });
  console.log(`2. Create project: status=${created.status}, id=${created.body.projectId}`);
  console.assert(created.status === 201, "Create project failed");
  const projectId = created.body.projectId;

  // Test 3: List projects
  const list = await request("GET", "/projects");
  console.log(`3. List projects: count=${list.body.length}`);
  console.assert(list.body.length === 1, "Expected 1 project");

  // Test 4: Get project
  const got = await request("GET", `/projects/${projectId}`);
  console.log(`4. Get project: title=${got.body.title}, status=${got.body.status}`);
  console.assert(got.status === 200, "Get project failed");

  // Test 5: Copy test novel to raw dir
  const rawDir = path.join(tmpDir, "projects", projectId, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const srcPath = "D:/Project/novel2glagame/2/《AI恋人》作者：妄初.txt";
  const destPath = path.join(rawDir, "novel.txt");
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`5. Copied test novel (${(fs.statSync(destPath).size / 1024).toFixed(0)}KB)`);
  } else {
    console.log(`5. SKIPPED: test novel not found at ${srcPath}`);
    server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // Test 6: Run structure
  console.log(`6. Running structure agent (this may take a few seconds)...`);
  const struct = await request("POST", `/projects/${projectId}/structure/run`);
  console.log(`   Status: ${struct.status}`);
  if (struct.status === 200) {
    console.log(`   Book: ${struct.body.bookTitle}`);
    console.log(`   Chapters: ${struct.body.chapterCount}`);
    console.log(`   Confidence: ${struct.body.confidence?.toFixed(3)}`);
    console.log(`   First 3: ${struct.body.chapters?.slice(0, 3).map((c: any) => c.title).join(", ")}`);
    console.assert(struct.body.chapterCount > 10, "Expected >10 chapters");
  } else {
    console.log(`   Error: ${JSON.stringify(struct.body)}`);
  }

  // Test 7: Get structure
  const structure = await request("GET", `/projects/${projectId}/structure`);
  console.log(`7. Get structure: chapters=${structure.body.chapters?.length}`);
  console.assert(structure.status === 200, "Get structure failed");

  // Test 8: List chapters
  const chapters = await request("GET", `/projects/${projectId}/chapters`);
  console.log(`8. List chapters: count=${chapters.body.length}`);
  console.assert(chapters.body.length > 0, "Expected chapters");

  // Test 9: Get tasks (should be empty - no LLM tasks run)
  const tasks = await request("GET", `/projects/${projectId}/tasks`);
  console.log(`9. Tasks: count=${tasks.body.length}`);

  // Cleanup
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n=== All integration tests passed! ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
