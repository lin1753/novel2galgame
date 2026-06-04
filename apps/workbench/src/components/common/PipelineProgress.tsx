import type { ChapterStatus } from '@novel2gal/core'
import { cn } from '@/lib/utils'

const pipelineStages: { key: ChapterStatus; label: string }[] = [
  { key: 'raw', label: '待处理' },
  { key: 'narrative_parsed', label: '解析' },
  { key: 'attributed', label: '归因' },
  { key: 'segmented', label: '分镜' },
  { key: 'scene_mapping', label: '映射' },
  { key: 'fidelity_reviewing', label: '审查' },
  { key: 'chapter_ready', label: '就绪' },
]

const statusOrder: ChapterStatus[] = [
  'raw', 'narrative_parsed', 'attributed', 'segmented', 'scene_mapping', 'fidelity_reviewing', 'chapter_ready',
]

export function PipelineProgress({ status }: { status: ChapterStatus }) {
  const currentIdx = status === 'failed' ? -1 : statusOrder.indexOf(status)

  return (
    <div className="flex items-center gap-1">
      {pipelineStages.map((stage, i) => {
        const isDone = currentIdx > i
        const isCurrent = currentIdx === i
        const isFailed = status === 'failed' && i === 0
        return (
          <div key={stage.key} className="flex items-center gap-1">
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                isDone && 'bg-green-500',
                isCurrent && 'bg-yellow-400 animate-pulse',
                isFailed && 'bg-red-500',
                !isDone && !isCurrent && !isFailed && 'bg-gray-600'
              )}
              title={stage.label}
            />
            {i < pipelineStages.length - 1 && (
              <div className={cn('w-4 h-px', isDone ? 'bg-green-500' : 'bg-gray-700')} />
            )}
          </div>
        )
      })}
    </div>
  )
}
