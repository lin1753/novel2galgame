import fs from "node:fs";
import path from "node:path";

export interface JsonResult<T> {
  ok: true;
  data: T;
}

export interface JsonError {
  ok: false;
  error: { message: string; code?: string };
}

export type JsonReadResult<T> = JsonResult<T> | JsonError;
export type JsonWriteResult = JsonResult<{ path: string }> | JsonError;

export function readJson<T>(filePath: string): JsonReadResult<T> {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: { message: `file not found: ${filePath}`, code: "ENOENT" } };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return { ok: true, data: JSON.parse(raw) as T };
  } catch (err: any) {
    return { ok: false, error: { message: err.message ?? String(err), code: err.code } };
  }
}

export function writeJson(filePath: string, data: unknown): JsonWriteResult {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return { ok: true, data: { path: filePath } };
  } catch (err: any) {
    return { ok: false, error: { message: err.message ?? String(err), code: err.code } };
  }
}
