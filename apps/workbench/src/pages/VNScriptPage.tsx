import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { sceneService } from '@/services/scenes'
import { ScrollText, Sparkles } from 'lucide-react'
import type { VNScript } from '@novel2gal/core'

const typeColors: Record<string, string> = {
  bg: 'bg-blue-100 text-blue-600', show: 'bg-green-100 text-green-600',
  hide: 'bg-gray-100 text-gray-500', narration: 'bg-slate-100 text-slate-600',
  say: 'bg-amber-100 text-amber-600', thought: 'bg-purple-100 text-purple-600',
  pause: 'bg-orange-100 text-orange-600', transition: 'bg-cyan-100 text-cyan-600',
}

export function VNScriptPage() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>()

  const { data: script, isLoading } = useQuery({
    queryKey: ['script', projectId, sceneId],
    queryFn: () => sceneService.getScript(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  })

  if (!sceneId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-lg mb-1">VN 脚本查看器</p>
          <p className="text-sm">从场景工作区选择一个场景查看脚本</p>
        </div>
      </div>
    )
  }

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">加载中...</div>
  if (!script) return <div className="p-8 text-center text-muted-foreground">未找到脚本</div>

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-sakura" />
        <h2 className="font-semibold text-deep-purple">{script.sceneId}</h2>
        <span className="text-xs text-muted-foreground">{script.steps.length} 步骤</span>
      </div>

      <div className="space-y-1">
        {script.steps.map((step, i) => (
          <div key={step.stepId} className="flex items-start gap-2 px-3 py-1.5 rounded-lg hover:bg-muted text-sm">
            <span className="text-[10px] text-muted-foreground w-6 text-right pt-0.5 shrink-0">{i + 1}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${typeColors[step.type] ?? 'bg-gray-100'}`}>
              {step.type}
            </span>
            <span className="text-foreground flex-1">
              {step.type === 'bg' && (step as any).backgroundLabel}
              {step.type === 'show' && `${(step as any).characterId} ${(step as any).expression ?? ''}`}
              {step.type === 'hide' && (step as any).characterId}
              {(step.type === 'say' || step.type === 'thought') && (
                <><span className="text-muted-foreground">[{(step as any).displayName ?? (step as any).characterId}]</span> {(step as any).text}</>
              )}
              {step.type === 'narration' && (step as any).text}
              {step.type === 'pause' && `${(step as any).durationMs ?? 1000}ms`}
              {step.type === 'transition' && (step as any).name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
