import { VNScriptSchema } from "../index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ["62ec_ch0001_s0001_normal.json", "62ec_ch0004_s0001_action.json", "62ec_ch0007_s0002_scene_desc.json"]) {
  const script = JSON.parse(fs.readFileSync(path.join(here, "corpus", f), "utf8"));
  const r = VNScriptSchema.safeParse(script);
  console.log(f, r.success ? "OK" : "FAIL");
  if (!r.success) for (const i of r.error.issues.slice(0, 4)) console.log("  ", i.path.join("."), "|", i.message.slice(0, 90));
}
