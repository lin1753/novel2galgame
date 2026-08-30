import type { VNScript, VNStep, Scene, AttributedNarrativeUnit, CharacterRef } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeVNSteps } from "../shared/normalize.js";

export interface VNMappingInput {
  sceneId: string;
  chapterId: string;
  scene: Scene;
  units: AttributedNarrativeUnit[];
  characters?: CharacterRef[];
  mappingMode: "standard" | "conservative";
  /** [REPAIR MODE] Issues from a failed fidelity review; instructs the LLM to fix omissions */
  repairContext?: string;
}

import { loadPrompt } from "../prompt-loader.js";

const DEFAULT_SYSTEM_PROMPT = `你是一个中文小说转视觉小说脚本专家。你的任务是将一个场景的叙事单元转换为 VN 脚本步骤，像一位专业的 Galgame 导演一样编排演出。

【极度重要】由于 API 输出长度存在严格限制，请你严格跳过所有分析、解释和内心独白！千万不要写“让我分析一下...”，请直接、立刻输出最终的 JSON 数组！

VN 步骤类型:
- bg: 背景切换 (backgroundId, backgroundLabel)
- show: 显示角色立绘 (characterId, expression, position, shotType, scale, emphasis, enterEffect)
- hide: 隐藏角色立绘 (characterId)
- narration: 旁白/叙述文字 (text)
- say: 角色对话 (characterId, displayName, text)
- thought: 角色内心独白 (characterId, displayName, text)
- action: 角色动作 (characterId, characterName, text)
- scene_description: 场景描写 (participantIds, text)
- pause: 暂停等待 (durationMs)
- transition: 过场效果 (name: fade/cut/dissolve, cameraEffect)

角色位置与同屏排布 rules (position 字段):
- 必须严格是 "left_far" | "left" | "center" | "right" | "right_far" 之一 (绝不可输出其他单词)
- 单角色场景: 使用 "center" (50%)
- 双角色对话: 说话者 "left" (30%)，倾听者 "right" (70%)（或反之，分立两侧）
- 三角色场景: 核心说话者居中 "center" (50%) 且 emphasis="focus"，左侧协同角色 "left_far" (15%) emphasis="dim"，右侧次要角色 "right_far" (85%) emphasis="dim"
- 四角色群像: 依次分列 "left_far" (15%), "left" (30%), "right" (70%), "right_far" (85%)。当前发言者自动设为 shotType="bust" 且 emphasis="focus"，其他 3 名倾听角色一律设为 emphasis="dim"

景别 rules (shotType 字段, 可选):
- "waist": 腰部半身像 (scale=1.0) — 50%~60% 日常对白默认采用
- "bust": 胸像近景 (scale=1.2) — 30% 深入对话/情感聚焦
- "closeup": 面部特写 (scale=1.5) — 10% 冲突/告白/惊吓
- "thigh": 中全景 (scale=0.9) — 群像/肢体互动
- "full_body": 全身像 (scale=0.82) — 角色初登场展示
- 不指定时默认为 "waist"

角色强调 rules (emphasis 字段, 可选):
- "focus": 说话者高亮聚焦 (亮度正常)
- "dim": 倾听者微暗淡化 (非说话方)
- "normal": 默认无特殊处理
- 双人对话时，当前说话者 show emphasis="focus"，另一方 show emphasis="dim"

镜头动效 rules (cameraEffect 字段, 放在 transition 步骤中):
- "shake_heavy": 争吵/受击/拍桌 (Ren'Py: vpunch)
- "shake_light": 迟疑/心慌 (Ren'Py: hpunch)
- "zoom_in_slow": 表白/沉思/心声 (Ren'Py: camera ease 2.0 zoom 1.25)
- "zoom_punch": 震惊/破案/揭晓 (Ren'Py: camera ease 0.15 zoom 1.45)
- "flash_white": 回忆闪回/重击 (Ren'Py: flash)
- 只在情绪转折点使用，不要滥用！每个场景最多 2-3 次镜头动效

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
    {"stepId": "step_0001_0002", "type": "show", "order": 1, "characterId": "char_001", "expression": "happy", "position": "left", "shotType": "waist", "emphasis": "focus", "sourceUnitIds": ["unit_0001_0002"]},
    {"stepId": "step_0001_0003", "type": "show", "order": 2, "characterId": "char_002", "expression": "neutral", "position": "right", "emphasis": "dim", "sourceUnitIds": ["unit_0001_0003"]},
    {"stepId": "step_0001_0004", "type": "say", "order": 3, "characterId": "char_001", "displayName": "名字", "text": "原文对话内容", "sourceUnitIds": ["unit_0001_0004"]},
    {"stepId": "step_0001_0005", "type": "transition", "order": 4, "name": "dissolve", "cameraEffect": "shake_light", "sourceUnitIds": []},
    {"stepId": "step_0001_0006", "type": "show", "order": 5, "characterId": "char_001", "expression": "angry", "position": "left", "shotType": "bust", "emphasis": "focus", "sourceUnitIds": ["unit_0001_0005"]}
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

  const BATCH_SIZE = 5;
  const unitBatches: AttributedNarrativeUnit[][] = [];
  for (let i = 0; i < units.length; i += BATCH_SIZE) {
    unitBatches.push(units.slice(i, i + BATCH_SIZE));
  }

  const allSteps: VNStep[] = [];
  const systemPrompt = loadPrompt("vn-mapping", DEFAULT_SYSTEM_PROMPT);

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
${input.repairContext ? `\n[REPAIR MODE] 上一次生成的 VN 脚本未通过保真度审核，请务必修复以下问题，补全所有被遗漏的叙事单元\n${input.repairContext}\n` : ""}
叙事单元:
${unitsText}

请输出 VN 脚本步骤 JSON。确保对话原文完全保留。`;

    const charMap: Record<string, string> = {};
    if (input.characters) {
      for (const c of input.characters) {
        charMap[c.characterId] = c.canonicalName;
        charMap[c.canonicalName] = c.canonicalName;
      }
    }
    for (const u of units) {
      const sid = u.attribution?.speakerId;
      if (sid && !sid.startsWith("char_") && !charMap[`char_${sid}`]) {
        charMap[`char_${sid}`] = sid;
      }
    }

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await provider.chatJson<{ steps: VNStep[] }>({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.4,
          maxTokens: 8192,
          jsonMode: true,
        });

        const normalizedSteps = normalizeVNSteps(result.steps ?? [], charMap);
        if (normalizedSteps.length === 0) {
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
      } catch (err: any) {
        if (err?.name === "AbortError" || err?.message?.includes("Aborted")) throw err;
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
            displayName: u.attribution?.speakerId ?? "未知",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else if (u.type === "thought") {
          allSteps.push({
            stepId: `step_${sceneId}_${randId}`,
            type: "thought",
            order: allSteps.length,
            characterId: u.attribution?.thinkerId ?? "unknown",
            displayName: u.attribution?.thinkerId ?? "未知",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else if (u.type === "action") {
          allSteps.push({
            stepId: `step_${sceneId}_${randId}`,
            type: "action",
            order: allSteps.length,
            characterId: u.attribution?.actorId ?? "unknown",
            characterName: u.attribution?.actorId ?? "未知",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else if (u.type === "scene_description") {
          allSteps.push({
            stepId: `step_${sceneId}_${randId}`,
            type: "scene_description",
            order: allSteps.length,
            participantIds: u.attribution?.participantIds ?? [],
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

  // ==== 强制容错后处理 (Post-processing) ====
  
  // 1. 确保开场必有 bg (背景)
  if (allSteps.length > 0 && allSteps[0].type !== "bg") {
    allSteps.unshift({
      stepId: `step_${sceneId}_auto_bg`,
      type: "bg",
      order: -1,
      backgroundId: `bg_${sceneId}`,
      backgroundLabel: scene.summary?.locationHint ?? "场景",
      sourceUnitIds: [],
    });
  }

  // 2. 确保角色发言前已被 show (出场)
  const shownCharacters = new Set<string>();
  const finalizedSteps: VNStep[] = [];
  
  for (const step of allSteps) {
    if (step.type === "hide") {
      if (step.characterId) shownCharacters.delete(step.characterId);
      finalizedSteps.push(step);
    } else if (step.type === "show") {
      if (step.characterId) shownCharacters.add(step.characterId);
      finalizedSteps.push(step);
    } else if (step.type === "say") {
      const cid = step.characterId;
      if (cid && cid !== "unknown" && cid !== "旁白" && !shownCharacters.has(cid)) {
        // Auto-inject a show command before they speak
        finalizedSteps.push({
          stepId: `step_${sceneId}_auto_show_${cid}_${Math.random().toString(36).slice(2, 6)}`,
          type: "show",
          order: 0,
          characterId: cid,
          expression: "neutral",
          position: "center",
          emphasis: "focus",
          sourceUnitIds: [],
        });
        shownCharacters.add(cid);
      }
      finalizedSteps.push(step);
    } else {
      finalizedSteps.push(step);
    }
  }

  // 重新对 steps 进行全局序号编排
  finalizedSteps.forEach((st, idx) => {
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
      steps: finalizedSteps,
      mappingMode,
    },
  };
}
