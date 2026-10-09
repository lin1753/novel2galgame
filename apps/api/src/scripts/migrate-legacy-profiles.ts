/**
 * One-time legacy character profiles migration script (M6).
 * Defaults to --dry-run to output migration_audit_report.json.
 * Use --apply to execute the merge and backup existing profiles.
 *
 * Lossless guarantees (learned from the first dry-run audit):
 * - pending_confirmation characters are kept as their own master profile
 *   (never dropped) and their proposal is recorded for manual review.
 * - merged profiles contribute their evidence/history to the target.
 * - gender is backfilled from the legacy profile, then from the basePrompt
 *   text (woman/man/girl/boy pronouns), else stays undefined for review.
 * - the top-level basePrompt mirror is kept in sync with baseline.basePrompt
 *   (assets.ts / renpy-builder read the top-level field).
 * - group-tableau names are flagged isGroup so builders skip solo sprites.
 * - co-occurrence scenes are read from segmentation.json (the actual on-disk
 *   name) and fall back to scene_segmentation.json.
 */

import fs from "node:fs";
import path from "node:path";
import { CanonicalEntityResolver, isGroupCharacterName } from "@novel2gal/core";

const args = process.argv.slice(2);
const isApply = args.includes("--apply");
const isDryRun = !isApply || args.includes("--dry-run");

const dataDir = path.resolve(process.cwd(), "data");
const projectsDir = path.join(dataDir, "projects");

if (!fs.existsSync(projectsDir)) {
  console.log(`No projects directory found at ${projectsDir}`);
  process.exit(0);
}

/** Count English gender words in a basePrompt to backfill missing gender. */
function inferGenderFromPrompt(basePrompt: string): "female" | "male" | undefined {
  const p = (basePrompt || "").toLowerCase();
  if (!p) return undefined;
  const femaleHits = (p.match(/\b(woman|women|girl|lady|female|she)\b/g) ?? []).length;
  const maleHits = (p.match(/\b(man|men|boy|male|he)\b/g) ?? []).length;
  if (femaleHits === 0 && maleHits === 0) return undefined;
  if (femaleHits === maleHits) return undefined;
  return femaleHits > maleHits ? "female" : "male";
}

function loadScenes(projPath: string): any[] {
  const scenes: any[] = [];
  const chaptersDir = path.join(projPath, "chapters");
  if (!fs.existsSync(chaptersDir)) return scenes;
  for (const ch of fs.readdirSync(chaptersDir)) {
    // On-disk name is segmentation.json (FILE_NAMES.segmentation); the old
    // script looked for scene_segmentation.json and silently got zero scenes,
    // disabling the co-occurrence hard block entirely.
    for (const name of ["segmentation.json", "scene_segmentation.json"]) {
      const segPath = path.join(chaptersDir, ch, name);
      if (fs.existsSync(segPath)) {
        try {
          const segData = JSON.parse(fs.readFileSync(segPath, "utf8"));
          if (Array.isArray(segData.scenes)) scenes.push(...segData.scenes);
        } catch {}
        break;
      }
    }
  }
  return scenes;
}

const projectFolders = fs.readdirSync(projectsDir).filter((f) => {
  return fs.statSync(path.join(projectsDir, f)).isDirectory();
});

console.log(`================================================================`);
console.log(`[Migration] Starting Character Profile Migration`);
console.log(`[Migration] Mode: ${isApply ? "APPLY (Writing changes with backup)" : "DRY-RUN (Audit only)"}`);
console.log(`[Migration] Found ${projectFolders.length} projects`);
console.log(`================================================================`);

for (const projId of projectFolders) {
  const projPath = path.join(projectsDir, projId);
  const profilesPath = path.join(projPath, "character_profiles.json");

  if (!fs.existsSync(profilesPath)) {
    console.log(`[${projId}] No character_profiles.json found, skipping.`);
    continue;
  }

  try {
    const rawContent = fs.readFileSync(profilesPath, "utf8");
    const oldProfiles = JSON.parse(rawContent);
    const oldKeys = Object.keys(oldProfiles);
    const alreadyMigrated = oldKeys.length > 0 && Object.values<any>(oldProfiles).every(
      (p) => p && typeof p === "object" && p.baseline && Array.isArray(p.aliasSet),
    );

    console.log(`\n[${projId}] Analyzing ${oldKeys.length} profiles (${alreadyMigrated ? "already master-format" : "legacy flat"})...`);

    const scenes = loadScenes(projPath);

    const newMasterProfiles: Record<string, any> = {};
    const auditLog: any[] = [];
    const pendingMerges: any[] = [];

    // Deterministic order: first-seen order in the file, so a project's
    // canonical masters keep stable IDs across dry-run and apply.
    for (const [cid, oldProf] of Object.entries<any>(oldProfiles)) {
      if (!oldProf || typeof oldProf !== "object") continue;
      const rawName = oldProf.canonicalName || cid;
      const rawId = oldProf.characterId || cid;

      const res = CanonicalEntityResolver.resolve(rawName, rawId, newMasterProfiles, {
        scenes,
      });

      if (res.action === "matched_existing") {
        const targetProf = newMasterProfiles[res.characterId];
        targetProf.aliasSet = Array.from(new Set([...targetProf.aliasSet, rawName, cid, ...(oldProf.aliasSet || [])]));
        // Lossless: carry evidence and history into the surviving master.
        if (Array.isArray(oldProf.evidence) && oldProf.evidence.length > 0) {
          targetProf.evidence = [...(targetProf.evidence || []), ...oldProf.evidence];
        }
        if (Array.isArray(oldProf.history) && oldProf.history.length > 0) {
          targetProf.history = [...(targetProf.history || []), ...oldProf.history];
        }
        // Gender upgrade only unknown -> known (pipeline invariant).
        if ((targetProf.gender === undefined || targetProf.gender === "unknown") && (oldProf.gender === "female" || oldProf.gender === "male")) {
          targetProf.gender = oldProf.gender;
        }
        if (oldProf.isGroup === true) targetProf.isGroup = true;
        auditLog.push({
          sourceId: cid,
          sourceName: rawName,
          action: "merged_into",
          targetId: res.characterId,
          targetCanonicalName: res.canonicalName,
          confidence: res.confidence,
          reason: res.reason,
        });
      } else if (res.action === "pending_confirmation") {
        // Lossless: keep the character as its own master instead of dropping
        // it — the proposal is recorded for manual review.
        // ID stability: existing vn_script/attributed_units data references
        // the legacy ID, so keep it rather than the resolver's generated one.
        const keepId = rawId && rawId.startsWith("char_") ? rawId : res.characterId;
        pendingMerges.push(res.pendingProposal);
        newMasterProfiles[keepId] = {
          characterId: keepId,
          canonicalName: rawName,
          aliasSet: Array.from(new Set([rawName, cid, ...(oldProf.aliasSet || [])])),
          gender: oldProf.gender,
          age: oldProf.age,
          personality: oldProf.personality,
          baseline: oldProf.baseline || {
            version: 1,
            basePrompt: oldProf.basePrompt || "",
            firstSeenChapter: oldProf.firstSeenChapter || "legacy",
            lockedAt: oldProf.updatedAt || new Date().toISOString(),
          },
          history: oldProf.history || [],
          evidence: oldProf.evidence || [],
          updatedAt: new Date().toISOString(),
        };
        auditLog.push({
          sourceId: cid,
          sourceName: rawName,
          action: "kept_separate_pending_review",
          candidateId: keepId,
          proposedMergeInto: res.pendingProposal?.targetCharacterId,
          reason: res.reason,
        });
      } else {
        // Created new Master Profile
        const basePrompt = oldProf.baseline?.basePrompt || oldProf.basePrompt || "";
        const gender = oldProf.gender === "female" || oldProf.gender === "male"
          ? oldProf.gender
          : inferGenderFromPrompt(basePrompt);
        const isGroup = oldProf.isGroup === true || isGroupCharacterName(rawName, gender);
        newMasterProfiles[res.characterId] = {
          characterId: res.characterId,
          canonicalName: res.canonicalName,
          aliasSet: Array.from(new Set([res.canonicalName, rawName, cid, ...(oldProf.aliasSet || [])])),
          gender,
          age: oldProf.age,
          personality: oldProf.personality,
          baseline: oldProf.baseline || {
            version: 1,
            basePrompt,
            firstSeenChapter: oldProf.firstSeenChapter || "legacy",
            lockedAt: oldProf.updatedAt || new Date().toISOString(),
          },
          history: oldProf.history || [],
          evidence: oldProf.evidence || [],
          updatedAt: new Date().toISOString(),
          ...(isGroup ? { isGroup: true } : {}),
        };
        auditLog.push({
          sourceId: cid,
          sourceName: rawName,
          action: "created_master",
          targetId: res.characterId,
          targetCanonicalName: res.canonicalName,
          reason: res.reason,
          ...(gender ? { genderBackfilledFrom: oldProf.gender ? "profile" : "basePrompt text" } : {}),
          ...(isGroup ? { isGroup: true } : {}),
        });
      }
    }

    const report = {
      projectId: projId,
      timestamp: new Date().toISOString(),
      mode: isApply ? "applied" : "dry_run",
      totalOldProfiles: oldKeys.length,
      mergedMasterProfiles: Object.keys(newMasterProfiles).length,
      reductionCount: oldKeys.length - Object.keys(newMasterProfiles).length,
      pendingConfirmationCount: pendingMerges.length,
      pendingMerges,
      auditLog,
    };

    if (isApply) {
      // Top-level basePrompt mirror: legacy readers (assets.ts route,
      // renpy-builder) read the top-level field; the pipeline keeps it in
      // sync on create. Keep migration output shape-compatible with both.
      for (const prof of Object.values<any>(newMasterProfiles)) {
        prof.basePrompt = prof.baseline?.basePrompt ?? "";
      }
    }

    const reportPath = path.join(projPath, "migration_audit_report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[${projId}] Audit report written to ${reportPath}`);
    console.log(`[${projId}] Results: ${oldKeys.length} old profiles -> ${Object.keys(newMasterProfiles).length} master profiles (${report.reductionCount >= 0 ? "-" : "+"}${Math.abs(report.reductionCount)}), ${pendingMerges.length} pending review`);

    if (isApply) {
      // Backup original
      const backupPath = path.join(projPath, "character_profiles.backup.json");
      fs.writeFileSync(backupPath, rawContent, "utf8");
      console.log(`[${projId}] Backup saved to ${backupPath}`);

      // Apply new
      fs.writeFileSync(profilesPath, JSON.stringify(newMasterProfiles, null, 2), "utf8");
      console.log(`[${projId}] Successfully applied new Master Profiles!`);
    } else {
      console.log(`[${projId}] DRY-RUN completed. Run with --apply to commit changes.`);
    }
  } catch (err) {
    console.error(`[${projId}] Error during migration:`, err);
  }
}

console.log(`\n================================================================`);
console.log(`[Migration] Finished!`);
console.log(`================================================================`);
