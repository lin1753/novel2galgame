/**
 * One-time legacy character profiles migration script.
 * Defaults to --dry-run to output migration_audit_report.json.
 * Use --apply to execute the merge and backup existing profiles.
 */

import fs from "node:fs";
import path from "node:path";
import { CanonicalEntityResolver } from "@novel2gal/core";

const args = process.argv.slice(2);
const isApply = args.includes("--apply");
const isDryRun = !isApply || args.includes("--dry-run");

const dataDir = path.resolve(process.cwd(), "data");
const projectsDir = path.join(dataDir, "projects");

if (!fs.existsSync(projectsDir)) {
  console.log(`No projects directory found at ${projectsDir}`);
  process.exit(0);
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

    console.log(`\n[${projId}] Analyzing ${oldKeys.length} legacy profiles...`);

    // Load scenes for co-occurrence checks if available
    const scenes: any[] = [];
    const chaptersDir = path.join(projPath, "chapters");
    if (fs.existsSync(chaptersDir)) {
      const chapterFolders = fs.readdirSync(chaptersDir);
      for (const ch of chapterFolders) {
        const segPath = path.join(chaptersDir, ch, "scene_segmentation.json");
        if (fs.existsSync(segPath)) {
          try {
            const segData = JSON.parse(fs.readFileSync(segPath, "utf8"));
            if (Array.isArray(segData.scenes)) scenes.push(...segData.scenes);
          } catch {}
        }
      }
    }

    const newMasterProfiles: Record<string, any> = {};
    const auditLog: any[] = [];
    const pendingMerges: any[] = [];

    for (const [cid, oldProf] of Object.entries<any>(oldProfiles)) {
      if (!oldProf) continue;
      const rawName = oldProf.canonicalName || cid;
      const rawId = oldProf.characterId || cid;

      const res = CanonicalEntityResolver.resolve(rawName, rawId, newMasterProfiles, {
        scenes,
      });

      if (res.action === "matched_existing") {
        const targetProf = newMasterProfiles[res.characterId];
        targetProf.aliasSet = Array.from(new Set([...targetProf.aliasSet, rawName, cid, ...(oldProf.aliasSet || [])]));
        if (oldProf.evidence && Array.isArray(oldProf.evidence)) {
          targetProf.evidence = [...(targetProf.evidence || []), ...oldProf.evidence];
        }
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
        pendingMerges.push(res.pendingProposal);
        auditLog.push({
          sourceId: cid,
          sourceName: rawName,
          action: "pending_confirmation",
          candidateId: res.characterId,
          reason: res.reason,
        });
      } else {
        // Created new Master Profile
        newMasterProfiles[res.characterId] = {
          characterId: res.characterId,
          canonicalName: res.canonicalName,
          aliasSet: Array.from(new Set([res.canonicalName, rawName, cid, ...(oldProf.aliasSet || [])])),
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
          updatedAt: new Date().toISOString(),
        };
        auditLog.push({
          sourceId: cid,
          sourceName: rawName,
          action: "created_master",
          targetId: res.characterId,
          targetCanonicalName: res.canonicalName,
          reason: res.reason,
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

    const reportPath = path.join(projPath, "migration_audit_report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[${projId}] Audit report written to ${reportPath}`);
    console.log(`[${projId}] Results: ${oldKeys.length} old profiles -> ${Object.keys(newMasterProfiles).length} master profiles (-${report.reductionCount})`);

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
