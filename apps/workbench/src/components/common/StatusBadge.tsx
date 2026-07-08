import type { ProjectStatus, ChapterStatus, SceneStatus } from '@novel2gal/core'

const projectStatusConfig: Record<ProjectStatus, { label: string; color: string }> = {
  created: { label: '已创建', color: 'bg-gray-500' },
  text_cleaned: { label: '文本已清洗', color: 'bg-blue-500' },
  structured: { label: '结构已解析', color: 'bg-blue-600' },
  chapter_processing: { label: '章节处理中', color: 'bg-yellow-500' },
  chapter_partial_ready: { label: '部分就绪', color: 'bg-yellow-600' },
  consistency_reviewing: { label: '一致性审查中', color: 'bg-purple-500' },
  preview_ready: { label: '可预览', color: 'bg-green-500' },
  completed: { label: '已完成', color: 'bg-green-600' },
  failed: { label: '失败', color: 'bg-red-500' },
}

const chapterStatusConfig: Record<ChapterStatus, { label: string; color: string }> = {
  raw: { label: '待处理', color: 'bg-gray-500' },
  running: { label: '运行中', color: 'bg-yellow-500' },
  narrative_parsed: { label: '已解析', color: 'bg-blue-500' },
  attributed: { label: '已归因', color: 'bg-blue-600' },
  segmented: { label: '已分镜', color: 'bg-cyan-500' },
  scene_mapping: { label: '映射中', color: 'bg-yellow-500' },
  fidelity_reviewing: { label: '审查中', color: 'bg-purple-500' },
  chapter_ready: { label: '就绪', color: 'bg-green-500' },
  failed: { label: '失败', color: 'bg-red-500' },
  cancelled: { label: '已取消', color: 'bg-gray-400' },
  crashed: { label: '已中断', color: 'bg-orange-500' },
}

const sceneStatusConfig: Record<SceneStatus, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'bg-gray-500' },
  mapped: { label: '已映射', color: 'bg-blue-500' },
  visual_prompt_ready: { label: '提示词就绪', color: 'bg-cyan-500' },
  fidelity_passed: { label: '审查通过', color: 'bg-green-500' },
  fidelity_failed: { label: '审查未通过', color: 'bg-red-500' },
  finalized: { label: '已完成', color: 'bg-green-600' },
}

type AnyStatus = ProjectStatus | ChapterStatus | SceneStatus

const allConfig: Record<string, { label: string; color: string }> = {
  ...projectStatusConfig,
  ...chapterStatusConfig,
  ...sceneStatusConfig,
}

export function StatusBadge({ status }: { status: AnyStatus }) {
  const cfg = allConfig[status] ?? { label: status, color: 'bg-gray-500' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white ${cfg.color}`}>
      {cfg.label}
    </span>
  )
}
