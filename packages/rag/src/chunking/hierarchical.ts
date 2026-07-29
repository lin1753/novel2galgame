/**
 * Hierarchical chunking: child chunks for embedding, parent doc for context.
 *
 * Strategy:
 * - Child chunks: small, focused text for high-precision retrieval
 * - Parent document: full character/scene info for context injection
 * - Each child links to its parent via parentDocId in metadata
 */
export interface HierarchicalChunk {
  id: string;
  childText: string;       // For embedding (small, focused)
  parentText: string;      // For context window (full info)
  parentDocId: string;     // Links children to parent
  chunkType: "identity" | "appearance" | "personality" | "relationship" | "quote" | "summary";
  metadata: Record<string, unknown>;
}

export function buildHierarchicalChunks(
  characterId: string,
  canonicalName: string,
  attributes: {
    appearance?: string[];
    personality?: string;
    relationships?: Record<string, string>;
    quotes?: string[];
  },
  chapterId: string,
  chapterTitle: string,
): HierarchicalChunk[] {
  const parentDocId = characterId;
  const chunks: HierarchicalChunk[] = [];

  // Build parent document (full context)
  const parentParts = [`角色: ${canonicalName}`];
  if (attributes.appearance?.length) parentParts.push(`外貌: ${attributes.appearance.join("; ")}`);
  if (attributes.personality) parentParts.push(`性格: ${attributes.personality}`);
  if (attributes.relationships) {
    parentParts.push(`关系: ${Object.entries(attributes.relationships).map(([k,v]) => `${k}→${v}`).join("; ")}`);
  }
  if (attributes.quotes?.length) parentParts.push(`典型台词: ${attributes.quotes.join("; ")}`);
  const parentText = parentParts.join(" | ");

  const baseMeta = { characterId, canonicalName, parentDocId, chapterId, firstSeenIn: chapterTitle };

  // 1. Identity chunk
  chunks.push({
    id: `${characterId}_identity`,
    childText: `${canonicalName}`,
    parentText,
    parentDocId,
    chunkType: "identity",
    metadata: { ...baseMeta, key: "identity" },
  });

  // 2-5. Attribute chunks
  if (attributes.appearance?.length) {
    for (const trait of attributes.appearance) {
      chunks.push({
        id: `${characterId}_appearance_${trait.slice(0, 20)}`,
        childText: `${canonicalName}: ${trait}`,
        parentText,
        parentDocId,
        chunkType: "appearance",
        metadata: { ...baseMeta, key: "appearance", trait },
      });
    }
  }

  if (attributes.personality) {
    chunks.push({
      id: `${characterId}_personality`,
      childText: `${canonicalName}: ${attributes.personality}`,
      parentText,
      parentDocId,
      chunkType: "personality",
      metadata: { ...baseMeta, key: "personality" },
    });
  }

  if (attributes.relationships) {
    for (const [relType, relName] of Object.entries(attributes.relationships)) {
      chunks.push({
        id: `${characterId}_relationship_${relName}`,
        childText: `${canonicalName}与${relName}: ${relType}`,
        parentText,
        parentDocId,
        chunkType: "relationship",
        metadata: { ...baseMeta, key: "relationship", relType, relName },
      });
    }
  }

  // 6. Quote chunks (one per quote)
  if (attributes.quotes?.length) {
    for (const quote of attributes.quotes.slice(0, 5)) { // Max 5 quotes per char
      chunks.push({
        id: `${characterId}_quote_${quote.slice(0, 30)}`,
        childText: `${canonicalName}: "${quote.slice(0, 80)}"`,
        parentText,
        parentDocId,
        chunkType: "quote",
        metadata: { ...baseMeta, key: "quote", quote: quote.slice(0, 80) },
      });
    }
  }

  return chunks;
}
