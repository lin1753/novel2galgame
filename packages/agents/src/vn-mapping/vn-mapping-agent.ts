import type { VNScript, VNStep, Scene, AttributedNarrativeUnit } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeVNSteps } from "../shared/normalize.js";

export interface VNMappingInput {
  sceneId: string;
  chapterId: string;
  scene: Scene;
  units: AttributedNarrativeUnit[];
  mappingMode: "standard" | "conservative";
  /** [REPAIR MODE] Issues from a failed fidelity review; instructs the LLM to fix omissions */
  repairContext?: string;
}

const SYSTEM_PROMPT = `你是一个中文小说转视觉小说脚本专家。你的任务是将一个场景的叙事单元转换为 VN 脚本步骤。

VN 步骤类型:
- bg: 背景切换 (backgroundId, backgroundLabel)
- show: 显示角色立绘 (characterId, expression, position)
- hide: 隐藏角色立绘 (characterId)
- narration: 旁白/叙述文字 (text)
- say: 角色对话 (characterId, displayName, text)
- thought: 角色内心独白 (characterId, displayName, text)
- pause: 暂停等待 (durationMs)
- transition: 过场效果 (name: fade/cut/dissolve)

角色位置 rules (position 字段):
- 必须是 "left_far" | "left" | "center" | "right" | "right_far" 之一
- 单角色场景: 使用 "center"
- 双角色对话: 说话者 "left"，倾听者 "right"（或反之，分立两侧）
- 三角色场景: 主角 "center"，其他角色分列 "left_far" / "right_far"
- 多人对峙场景: 动态穿插 "left_far", "left", "center", "right", "right_far"

规则:
1. 对话必须保留原文, 不得改写 (关键要求!)
2. 非原文添加量必须最小化 (<=5%)
3. 每个步骤需要 sourceUnitIds 关联到原始叙事单元
4. 场景开始时应设置 bg, 有角色说话时 show
5. conservative 模式下更保守, standard 模式下更丰富

输出 JSON 格式 (必须严格遵守字段名):
{
  "steps": [
    {"stepId": "step_0001_0001", "type": "bg", "order": 0, "backgroundId": "school_classroom", "backgroundLabel": "教室", "sourceUnitIds": ["unit_0001_0001"]},
    {"stepId": "step_0001_0002", "type": "show", "order": 1, "characterId": "char_001", "expression": "happy", "position": "left", "sourceUnitIds": ["unit_0001_0002"]},
    {"stepId": "step_0001_0003", "type": "show", "order": 2, "characterId": "char_002", "expression": "neutral", "position": "right", "sourceUnitIds": ["unit_0001_0003"]},
    {"stepId": "step_0001_0004", "type": "say", "order": 3, "characterId": "char_001", "displayName": "名字", "text": "原文对话内容", "sourceUnitIds": ["unit_0001_0004"]},
    {"stepId": "step_0001_0005", "type": "narration", "order": 4, "text": "旁白内容", "sourceUnitIds": ["unit_0001_0005"]},
    {"stepId": "step_0001_0006", "type": "thought", "order": 5, "characterId": "char_001", "displayName": "名字", "text": "内心独白", "sourceUnitIds": ["unit_0001_0006"]},
    {"stepId": "step_0001_0007", "type": "transition", "order": 6, "name": "fade", "sourceUnitIds": []}
  ]
}`;

export async function runVNMappingAgent(
  input: VNMappingInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<VNScript>> {
  const { sceneId, chapterId, scene, units, mappingMode } = input;

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "recoverable", errorMessage: "No units in scene" };
  }

  // 合理的批次大小（25 个单元），既能保证完整输出不超 token，又能将 API 请求数降低 90%
  const BATCH_SIZE = 25;
  const unitBatches: AttributedNarrativeUnit[][] = [];
  for (let i = 0; i < units.length; i += BATCH_SIZE) {
    unitBatches.push(units.slice(i, i + BATCH_SIZE));
  }

  const allSteps: VNStep[] = [];

  for (let bIdx = 0; bIdx < unitBatches.length; bIdx++) {
    const batchUnits = unitBatches[bIdx];
    const unitsText = batchUnits
      .map((u) => {
        const attr = u.attribution
          ? ` [speaker=${u.attribution.speakerId ?? "?"}]`
          : "";
        return `[${u.order}] (${u.type}${attr}) ${u.originalText ?? ""}`;
      })
      .join("\n");

    const userPrompt = `请将以下场景转换为 VN 脚本。

场景ID: ${sceneId}
章节ID: ${chapterId}
模式: ${mappingMode}
场景摘要: ${scene.summary?.shortSummary ?? "无"}
场景位置: ${scene.summary?.locationHint ?? "未知"}
${unitBatches.length > 1 ? `[批次 ${bIdx + 1}/${unitBatches.length}]` : ""}
${input.repairContext ? `\n[REPAIR MODE] 上一次生成的 VN 脚本未通过保真度审核，请务必修复以下问题，补全所有被遗漏的叙事单元:\n${input.repairContext}\n` : ""}
叙事单元:
${unitsText}

请输出 VN 脚本步骤 JSON。确保对话原文完全保留!`;

    // 构建局部角色映射表
    const charMap: Record<string, string> = {};
    for (const u of units) {
      const sid = u.attribution?.speakerId;
      if (sid && !sid.startsWith("char_")) {
        charMap[`char_${sid}`] = sid;
      }
    }

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await provider.chatJson<{ steps: VNStep[] }>({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          maxTokens: 8192,
          jsonMode: true,
        });

        const normalizedSteps = normalizeVNSteps(result.steps ?? [], charMap);
        if (normalizedSteps.length === 0) {
          // Some providers occasionally return an empty steps array on a 200 —
          // retry, and let the per-unit fallback kick in if it persists
          console.warn(`[vn-mapping-agent] Batch ${bIdx + 1}/${unitBatches.length} returned empty steps (attempt ${attempt + 1})`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            continue;
          }
          break;
        }
        allSteps.push(...normalizedSteps);
        success = true;
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const is429 = errMsg.includes("429") || errMsg.includes("rate limit");
        if (is429 && attempt < 2) {
          console.warn(`[vn-mapping-agent] Batch ${bIdx + 1} hit 429, backoff 2500ms...`);
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        } else {
          console.warn(`[vn-mapping-agent] Batch ${bIdx + 1}/${unitBatches.length} failed: ${errMsg}`);
          break;
        }
      }
    }

    if (!success) {
      // 触发单元保底生成，保留原始台词与旁白
      for (const u of batchUnits) {
        const randId = Math.random().toString(36).slice(2, 8);
        if (u.type === "dialogue") {
          allSteps.push({
            stepId: `step_${sceneId}_${randId}`,
            type: "say",
            order: allSteps.length,
            characterId: u.attribution?.speakerId ?? "unknown",
            displayName: u.attribution?.speakerId ?? "角色",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else {
          allSteps.push({
            stepId: `step_${sceneId}_${randId}`,
            type: "narration",
            order: allSteps.length,
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        }
      }
    }
  }

  // 重新对 steps 进行全局序号编排
  allSteps.forEach((st, idx) => {
    st.order = idx;
    if (!st.stepId || st.stepId.startsWith("step_unknown_")) {
      st.stepId = `step_${sceneId}_${String(idx).padStart(4, "0")}`;
    }
  });

  return {
    success: true,
    data: {
      sceneId,
      chapterId,
      steps: allSteps,
      mappingMode,
    },
  };
}
