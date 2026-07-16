/**
 * Multi-agent debate mechanism for resolving ambiguous attribution.
 *
 * When confidence < 0.5, spawn 3 agents with different strategies,
 * collect their opinions, and use a moderator LLM to reach consensus.
 */
import type { LLMProvider } from "@novel2gal/providers";

export interface DebateOpinion {
  agentName: string;
  strategy: string;
  speaker: string;
  confidence: number;
  reasoning: string;
}

export interface DebateResult {
  speaker: string;
  confidence: number;
  consensus: "unanimous" | "majority" | "moderated" | "split";
  opinions: DebateOpinion[];
}

export async function debateAttribution(
  units: Array<{ unitId: string; text: string; type: string }>,
  knownCharacters: string[],
  provider: LLMProvider,
  model: string,
): Promise<DebateResult> {
  // Strategies for different perspectives
  const strategies = [
    {
      name: "dialog_chain",
      description: "分析对话链: 追踪连续对话的说话人切换模式",
    },
    {
      name: "pronoun_resolution",
      description: "代词消解: 解析'他/她/我/你'在上下文中的指代对象",
    },
    {
      name: "context_window",
      description: "扩大上下文: 利用前后50个narrative unit的角色出现模式推断",
    },
  ];

  // 1. Parallel debate - each strategy runs independently
  const opinions: DebateOpinion[] = [];
  for (const strategy of strategies) {
    try {
      const prompt = `${strategy.description}

已知角色: ${knownCharacters.join(", ")}

文本:
${units.map(u => `[${u.unitId}] (${u.type}) ${u.text}`).join("\n")}

请判断每段对话(dialogue)的说话人。输出格式:
{"attributions": [{"unitId": "u1", "speaker": "角色名", "confidence": 0.8, "reasoning": "..."}]}`;

      const result = await provider.chatJson<{
        attributions: Array<{ unitId: string; speaker: string; confidence: number; reasoning: string }>;
      }>({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        jsonMode: true,
      });

      for (const attr of result.attributions) {
        opinions.push({
          agentName: strategy.name,
          strategy: strategy.description,
          speaker: attr.speaker,
          confidence: attr.confidence,
          reasoning: attr.reasoning,
        });
      }
    } catch {
      // Strategy failed — skip
    }
  }

  // 2. Check consensus
  if (opinions.length === 0) {
    return { speaker: "unknown", confidence: 0, consensus: "split", opinions };
  }

  const speakerVotes = new Map<string, number>();
  for (const op of opinions) {
    speakerVotes.set(op.speaker, (speakerVotes.get(op.speaker) ?? 0) + 1);
  }

  const maxVotes = Math.max(...speakerVotes.values());
  const totalOpinions = opinions.length;

  if (maxVotes === totalOpinions) {
    // Unanimous
    const winner = [...speakerVotes.entries()].find(([, v]) => v === maxVotes)!;
    return { speaker: winner[0], confidence: 0.9, consensus: "unanimous", opinions };
  }

  if (maxVotes > totalOpinions / 2) {
    // Majority
    const winner = [...speakerVotes.entries()].find(([, v]) => v === maxVotes)!;
    return { speaker: winner[0], confidence: 0.7, consensus: "majority", opinions };
  }

  // 3. No consensus → moderated decision
  try {
    const debateSummary = opinions
      .map((o) => `[${o.agentName}] 认为说话人是 **${o.speaker}** (confidence: ${o.confidence})
  理由: ${o.reasoning}`)
      .join("\n\n");

    const verdict = await provider.chatJson<{ speaker: string; confidence: number }>({
      model,
      messages: [
        {
          role: "system",
          content: "你是仲裁者。多个归因 Agent 对说话人归属有分歧。请综合各方论据做出最终裁决。",
        },
        {
          role: "user",
          content: `各方意见:\n${debateSummary}\n\n请给出最终裁决。`,
        },
      ],
      temperature: 0,
      jsonMode: true,
    });

    return {
      speaker: verdict.speaker,
      confidence: Math.min(verdict.confidence, 0.6),
      consensus: "moderated",
      opinions,
    };
  } catch {
    // Moderator failed → pick majority or first opinion
    const firstSpeaker = opinions[0]?.speaker ?? "unknown";
    return { speaker: firstSpeaker, confidence: 0.3, consensus: "split", opinions };
  }
}

/** Detect high-ambiguity units that warrant debate */
export function detectAmbiguity(attributionResult: any): Array<{
  unitIds: string[];
  reason: string;
}> {
  const ambiguous: Array<{ unitIds: string[]; reason: string }> = [];

  for (const unit of attributionResult.units ?? []) {
    if ((unit.attributionConfidence ?? unit.confidence ?? 1) < 0.3) {
      ambiguous.push({
        unitIds: [unit.unitId],
        reason: `Low confidence (${unit.attributionConfidence ?? unit.confidence})`,
      });
    }
  }

  return ambiguous;
}
