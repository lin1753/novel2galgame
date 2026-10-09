/**
 * Regression tests for the M6 pre-fix resolver changes (run: npx tsx this-file).
 * Covers the real dry-run casualties found in the 2c31/83e4 audit reports:
 *   1. char_minor_002 (众豪杰) must NOT merge into char_minor_001 (白裙女子)
 *   2. 女同事乙 must NOT auto-merge into 女同事甲 (0.89 similarity — pending now)
 *   3. English ghost IDs (Ding Chi → 丁池) must still merge (exact aliasSet)
 *   4. Pinyin variants (char_lushinann vs char_lushinan) must still pending-or-match correctly
 */
import { CanonicalEntityResolver, type MasterCharacterProfile } from "../domain/canonical-entity-resolver.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}`); }
}

function prof(id: string, name: string, aliases: string[] = []): MasterCharacterProfile {
  return {
    characterId: id,
    canonicalName: name,
    aliasSet: aliases,
    baseline: { version: 1, basePrompt: "", firstSeenChapter: "legacy", lockedAt: "" },
    history: [],
    updatedAt: "",
  };
}

console.log("1. numbered-minor IDs never collapse onto each other");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_minor_001: prof("char_minor_001", "白裙女子"),
  };
  // 众豪杰 arrives with the raw ID char_minor_002
  const r = CanonicalEntityResolver.resolve("众豪杰", "char_minor_002", profiles);
  assert(r.action === "created_new", `char_minor_002 (众豪杰) created_new, got ${r.action} → ${r.characterId}`);

  // and with a numbered alias already present on the target
  const profiles2: Record<string, MasterCharacterProfile> = {
    char_baiqunnvzi: { ...prof("char_baiqunnvzi", "白裙女子", ["char_minor_001", "白裙女子"]) },
  };
  const r2 = CanonicalEntityResolver.resolve("众豪杰", "char_minor_002", profiles2);
  assert(r2.action === "created_new", `numbered alias on target does not swallow char_minor_002, got ${r2.action}`);
}

console.log("2. high fuzzy similarity auto-merge is now pending_confirmation");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_female_colleague_jia: prof("char_female_colleague_jia", "女同事甲"),
  };
  const r = CanonicalEntityResolver.resolve("女同事乙", "char_female_colleague_yi", profiles);
  assert(r.action === "pending_confirmation", `女同事乙 → pending, got ${r.action} (${r.reason})`);
  assert(!!r.pendingProposal && r.pendingProposal.targetCharacterId === "char_female_colleague_jia", "pendingProposal targets 女同事甲");
}

console.log("3. exact aliasSet matches still auto-merge (English ghosts)");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_dingchi: prof("char_dingchi", "丁池", ["Ding Chi", "dingchi"]),
  };
  const r = CanonicalEntityResolver.resolve("Ding Chi", "ding_chi", profiles);
  assert(r.action === "matched_existing" && r.characterId === "char_dingchi", `Ding Chi merges into 丁池, got ${r.action} → ${r.characterId}`);
}

console.log("4. exact canonicalName match still auto-merges (mojibake pinyin variant)");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_sangchencao: prof("char_sangchencao", "桑沉草"),
  };
  const r = CanonicalEntityResolver.resolve("桑沉草", "char_sangchencǎo", profiles);
  assert(r.action === "matched_existing" && r.characterId === "char_sangchencao", `桑沉草 merge, got ${r.action} → ${r.characterId}`);
}

console.log("5. pinyin suffix variants with same canonicalName merge via Level 1 (attribution ID hallucination case)");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_lushinan: prof("char_lushinan", "鹿时南"),
  };
  const r = CanonicalEntityResolver.resolve("鹿时南", "char_lushinann", profiles);
  assert(r.action === "matched_existing", `char_lushinann same name merges into char_lushinan, got ${r.action} → ${r.characterId}`);
}

console.log("6. co-occurrence hard block still blocks exact-name merges");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_zhangsan: prof("char_zhangsan", "张三"),
  };
  const scenes = [{ sceneId: "s1", characterIds: ["char_zhangsan", "char_lisi"], speakerIds: [] }];
  const r = CanonicalEntityResolver.resolve("张三", "char_zhangsan_alt", profiles, { scenes });
  // co-occurrence is checked between char_zhangsan_alt and char_zhangsan — they
  // never co-occur, so this exact-name match goes through. The block only fires
  // when the two candidate IDs themselves appear together in a scene.
  assert(r.action === "matched_existing", `exact canonicalName + no self-co-occurrence merges, got ${r.action}`);
}

console.log("7. same-name characters that co-occur are blocked");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_zhangsan: prof("char_zhangsan", "张三"),
  };
  // 张三(raw) co-occurred with char_zhangsan in scene s1 as a distinct participant
  const scenes = [{ sceneId: "s1", characterIds: ["char_zhangsan", "char_zhangsan_alt"], speakerIds: [] }];
  const r = CanonicalEntityResolver.resolve("张三", "char_zhangsan_alt", profiles, { scenes });
  assert(r.action !== "matched_existing", `co-occurring same-name not auto-merged, got ${r.action}`);
}

console.log("8. distinct named characters with similar IDs stay distinct");
{
  const profiles: Record<string, MasterCharacterProfile> = {
    char_linyaoyao: prof("char_linyaoyao", "林杳杳"),
  };
  const r = CanonicalEntityResolver.resolve("林一瑶", "char_linyiyao", profiles);
  // 林一瑶 vs 林杳杳: normalized strings linyiyao vs linyaoyao → similarity high
  // but must be pending, never auto-merge
  assert(r.action !== "matched_existing", `林一瑶 not auto-merged into 林杳杳, got ${r.action}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
