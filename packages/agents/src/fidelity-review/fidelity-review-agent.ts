import type { FidelityReport, VNScript, NarrativeUnit } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { sanitizeForPrompt } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface FidelityReviewInput {
  sceneId: string;
  chapterId: string;
  vnScript: VNScript;
  originalUnits: NarrativeUnit[];
}

export const SYSTEM_PROMPT = `你是一个视觉小说脚本忠实度审核专家。你的任务是审核 VN 脚本是否忠实于原始小说文本。

检查项:
- dialogue_rewrite: 对话被改写
- content_omission: 重要内容被遗漏
- wrong_attribution: 说话人标注错误
- type_mismatch: 类型映射错位（如将对话或内心活动粗暴降级为普通旁白，未正确使用 say 或 thought 指令）
- order_changed: 内容顺序被改变
- unsupported_addition: 添加了原文没有的内容
- semantic_drift: 语义偏离原文

严重级:
- minor: 小问题, 不影响体验
- major: 较大问题, 需要修复
- critical: 严重问题, 必须修复

规则:
1. 逐条对比 VN 步骤与原始叙事单元
2. 对话原文必须一字不差
3. 原始单元的类型属性（如 thought、action、dialogue）在转换为 VN 脚本时，其语义类型必须得到合理的继承，严禁将明显带角色的内心活动降级为旁白
4. 发现问题时给出修复建议 (suggestion)

输出 JSON 格式:
{
  "passed": true/false,
  "severity": "pass|minor|major|critical",
  "issues": [
    {
      "issueId": "issue_001",
      "type": "dialogue_rewrite",
      "severity": "major",
      "message": "描述",
      "relatedUnitIds": ["unitId"],
      "relatedStepIds": ["stepId"],
      "suggestion": "修复建议"
    }
  ]
}

【强制格式约束】
你输出的 JSON 字符串值中严禁出现未转义的控制字符和英文双引号 (")！
如果内容中包含对话，必须将其替换为中文双引号 (“ ”) 或转义为 \\"。绝不允许产生破坏 JSON 语法的格式，否则将导致系统崩溃！`;

export async function runFidelityReviewAgent(
  input: FidelityReviewInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<FidelityReport>> {
  const { sceneId, chapterId, vnScript, originalUnits } = input;
  const systemPrompt = loadPrompt("fidelity-review", SYSTEM_PROMPT);

  const scriptText = vnScript.steps
    .map((s) => {
      if ("text" in s) return `[${s.order}](${s.type}) ${sanitizeForPrompt((s as { text: string }).text)}`;
      if ("backgroundLabel" in s) return `[${s.order}](${s.type}) ${(s as { backgroundLabel?: string }).backgroundLabel ?? ""}`;
      return `[${s.order}](${s.type})`;
    })
    .join("\n");

  const originalText = originalUnits
    .map((u) => `[${u.order}](${u.type}) ${sanitizeForPrompt(u.originalText)}`)
    .join("\n");

  const userPrompt = `请审核以下 VN 脚本的忠实度。

场景ID: ${sceneId}
章节ID: ${chapterId}

原始叙事单元:
${originalText}

VN 脚本步骤:
${scriptText}

【最终警告】请直接输出 JSON，禁止包含任何思考过程！不要输出任何多余的中文字符！
请输出审核结果 JSON。`;

  try {
    const result = await provider.chatJson<Omit<FidelityReport, "sceneId" | "chapterId" | "reviewedAt">>({
      model,
      messages: [
          { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: 16384,
      jsonMode: true,
    });

    return {
      success: true,
      data: {
        sceneId,
        chapterId,
        passed: result.passed ?? false,
        severity: result.severity ?? "critical",
        issues: result.issues ?? [],
        reviewedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      success: false,
      failureLevel: "recoverable",
      errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
