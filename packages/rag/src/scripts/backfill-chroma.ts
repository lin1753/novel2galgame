/**
 * One-time Chroma backfill (issue-tracker A1).
 * Pushes every JSON-side record into the Chroma collections so the
 * Chroma-first read path (searchByVectorAsync / searchAsync) has data.
 *
 * IDs are derived exactly like the ingest paths do, so a later pipeline
 * re-ingest of the same content upserts in place (A3 determinism):
 *   characters: `${chapterId}_${characterId}_${chunkType}` (ingestChunks scheme)
 *   scenes:      chapterId (JSON record id, mirrored)
 *
 * Run: pnpm --filter @novel2gal/rag exec tsx src/scripts/backfill-chroma.ts
 * Idempotent: upserts by ID; safe to re-run.
 */
import { EmbeddingService } from "../embedder.js";
import { KnowledgeStore } from "../index.js";

async function main() {
  const dataDir = process.env.DATA_DIR || "data";
  const store = new KnowledgeStore(dataDir, new EmbeddingService({ local: true }));

  console.log("=== Chroma backfill ===");
  console.log("embedder:", store.embedderMode);

  // ── characters ──
  const charRecords = store.characters.getAll();
  console.log(`characters JSON records: ${charRecords.length}`);
  const charChroma = (store.characters as any).chroma;
  if (!charChroma) { console.log("no chroma client on characters — is CHROMA_URL set?"); process.exit(1); }
  let charOk = 0, charSkip = 0;
  for (const r of charRecords) {
    const m = r.metadata;
    // Legacy records carry `type` (identity/appearance/...), newer ones
    // `chunkType` — mirror the ingest-path ID scheme on whichever is present.
    const chunkType = (m.chunkType as string) ?? (m.type as string) ?? "identity";
    const id = `${(m.chapterId as string) ?? ""}_${(m.characterId as string) ?? ""}_${chunkType}`;
    // Direct chroma upsert — vectors are already stored JSON-side
    try {
      await charChroma.upsert([{ id, vector: r.vector, metadata: m, updatedAt: r.updatedAt }]);
      charOk++;
    } catch (e) {
      charSkip++;
      if (charSkip <= 3) console.warn("char upsert fail:", id, (e as Error).message?.slice(0, 120));
    }
  }
  console.log(`characters: ${charOk} upserted, ${charSkip} failed`);

  // ── scenes ──
  const sceneRecords = store.scenes.getAll();
  console.log(`scenes JSON records: ${sceneRecords.length}`);
  const sceneChroma = (store.scenes as any).chroma;
  if (!sceneChroma) { console.log("no chroma client on scenes — is CHROMA_URL set?"); process.exit(1); }
  let sceneOk = 0, sceneFail = 0;
  for (const r of sceneRecords) {
    try {
      await sceneChroma.upsert([{ id: r.id, vector: r.vector, metadata: r.metadata, updatedAt: r.updatedAt }]);
      sceneOk++;
    } catch (e) {
      sceneFail++;
      if (sceneFail <= 3) console.warn("scene upsert fail:", r.id, (e as Error).message?.slice(0, 120));
    }
  }
  console.log(`scenes: ${sceneOk} upserted, ${sceneFail} failed`);

  // ── verify ──
  try {
    const charChroma = (store.characters as any).chroma;
    const sceneChroma = (store.scenes as any).chroma;
    console.log(`verify — chroma characters count: ${await charChroma?.count?.()}`);
    console.log(`verify — chroma scenes count: ${await sceneChroma?.count?.()}`);
  } catch (e) {
    console.warn("verify failed:", (e as Error).message?.slice(0, 200));
  }
  process.exit(0);
}

void main();
