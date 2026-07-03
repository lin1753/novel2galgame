import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { chapterService } from '@/services/chapters'
import { sceneService } from '@/services/scenes'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Layers, Sparkles, Play, FileText, Loader2, Eye } from 'lucide-react'
import type { SceneState, VNScript, NarrativeParsingResult, AttributionResult, FidelityReport } from '@novel2gal/core'

export function ScenesPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { chapterId: routeChapterId } = useParams<{ chapterId?: string }>()
  const queryClient = useQueryClient()
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(routeChapterId ?? null)
  const [selectedScene, setSelectedScene] = useState<SceneState | null>(null)
  const [activeTab, setActiveTab] = useState<'script' | 'parsed' | 'attribution' | 'fidelity'>('script')

  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => chapterService.list(projectId!),
    enabled: !!projectId,
  })

  const { data: scenes, isLoading: scenesLoading } = useQuery({
    queryKey: ['scenes', projectId, selectedChapterId],
    queryFn: () => sceneService.listByChapter(projectId!, selectedChapterId!),
    enabled: !!projectId && !!selectedChapterId,
  })

  // Real data queries
  const { data: vnScript } = useQuery({
    queryKey: ['script', projectId, selectedScene?.sceneId],
    queryFn: () => sceneService.getScript(projectId!, selectedScene!.sceneId),
    enabled: !!projectId && !!selectedScene && activeTab === 'script',
  })

  const { data: narrativeResult } = useQuery({
    queryKey: ['narrative', projectId, selectedChapterId],
    queryFn: () => sceneService.getNarrativeResult(projectId!, selectedChapterId!),
    enabled: !!projectId && !!selectedChapterId && activeTab === 'parsed',
  })

  const { data: attributionResult } = useQuery({
    queryKey: ['attribution', projectId, selectedChapterId],
    queryFn: () => sceneService.getAttributionResult(projectId!, selectedChapterId!),
    enabled: !!projectId && !!selectedChapterId && activeTab === 'attribution',
  })

  const { data: fidelityReport } = useQuery({
    queryKey: ['fidelity', projectId, selectedScene?.sceneId],
    queryFn: () => sceneService.getFidelity(projectId!, selectedScene!.sceneId),
    enabled: !!projectId && !!selectedScene && activeTab === 'fidelity',
  })

  // Mutations
  const runChapterPipeline = useMutation({
    mutationFn: () => chapterService.run(projectId!, selectedChapterId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenes', projectId, selectedChapterId] })
      queryClient.invalidateQueries({ queryKey: ['chapters', projectId] })
    },
  })

  const runVisualPromptMutation = useMutation({
    mutationFn: () => sceneService.runVisualPrompt(projectId!, selectedScene!.sceneId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['visual-prompt', projectId, selectedScene?.sceneId] })
    },
  })

  // Auto-select first chapter with scenes
  if (!selectedChapterId && chapters && chapters.length > 0) {
    const withScenes = chapters.find((c: any) => c.sceneIds && c.sceneIds.length > 0)
    if (withScenes) setSelectedChapterId(withScenes.chapterId)
  }

  const resetTab = () => {
    setSelectedScene(null)
    setActiveTab('script')
  }

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Chapter + Scene List */}
      <aside className="w-60 border-r border-border overflow-auto shrink-0 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-sakura" />
          <h3 className="font-medium text-sm text-deep-purple">章节/场景</h3>
        </div>

        {chapters?.filter((c: any) => c.sceneIds && c.sceneIds.length > 0).map((ch: any) => (
          <div key={ch.chapterId} className="mb-3">
            <button
              onClick={() => { setSelectedChapterId(ch.chapterId); resetTab() }}
              className={`w-full text-left px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                selectedChapterId === ch.chapterId
                  ? 'bg-lavender/20 text-deep-purple'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {ch.title}
            </button>
            {selectedChapterId === ch.chapterId && scenes && (
              <div className="ml-2 mt-1 space-y-0.5">
                {scenes.map((sc, i) => (
                  <button
                    key={sc.sceneId}
                    onClick={() => setSelectedScene(sc)}
                    className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                      selectedScene?.sceneId === sc.sceneId
                        ? 'bg-sakura/10 text-deep-purple font-medium'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    场景 {i + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </aside>

      {/* Center: Content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedScene ? (
          <div className="text-center py-20 text-muted-foreground">
            <Layers className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>选择章节和场景查看详情</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-deep-purple">{selectedScene.sceneId}</h3>
              <StatusBadge status={selectedScene.status} />
            </div>

            <div className="flex gap-1 border-b border-border">
              {(['script', 'parsed', 'attribution', 'fidelity'] as const).map((tab) => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                    activeTab === tab ? 'border-lavender text-deep-purple font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}>
                  {tab === 'script' ? 'VN 脚本' : tab === 'parsed' ? '叙事解析' : tab === 'attribution' ? '归因' : '忠实性'}
                </button>
              ))}
            </div>

            <div className="border border-border rounded-xl p-4 min-h-[200px] text-sm bg-card">
              <TabContent
                tab={activeTab}
                script={vnScript ?? null}
                narrative={narrativeResult ?? null}
                attribution={attributionResult ?? null}
                fidelity={fidelityReport ?? null}
                selectedScene={selectedScene}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right: Operations */}
      <aside className="w-56 border-l border-border p-4 shrink-0">
        <h3 className="font-medium mb-3 text-sm text-deep-purple">操作</h3>
        {selectedChapterId && (
          <div className="space-y-2 mb-4">
            <button
              onClick={() => runChapterPipeline.mutate()}
              disabled={runChapterPipeline.isPending}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl text-sm font-medium disabled:opacity-50 transition-all hover:shadow-md"
            >
              {runChapterPipeline.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {runChapterPipeline.isPending ? '运行中...' : '运行整章管线'}
            </button>
          </div>
        )}
        {selectedScene && (
          <div className="space-y-2">
            <Link
              to={`/projects/${projectId}/script/${selectedScene.sceneId}`}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-muted transition-colors"
            >
              <FileText className="w-3.5 h-3.5" /> 查看 VN 脚本
            </Link>
            <button
              onClick={() => setActiveTab('fidelity')}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-muted transition-colors"
            >
              <Eye className="w-3.5 h-3.5" /> 查看忠实性报告
            </button>
            <button
              onClick={() => runVisualPromptMutation.mutate()}
              disabled={runVisualPromptMutation.isPending}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-muted transition-colors disabled:opacity-50"
            >
              {runVisualPromptMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              {runVisualPromptMutation.isPending ? '生成中...' : '生成视觉提示'}
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

function TabContent({
  tab, script, narrative, attribution, fidelity, selectedScene,
}: {
  tab: string
  script: VNScript | null
  narrative: NarrativeParsingResult | null
  attribution: AttributionResult | null
  fidelity: FidelityReport | null
  selectedScene: SceneState
}) {
  const typeColors: Record<string, string> = {
    bg: 'bg-blue-100 text-blue-600', show: 'bg-green-100 text-green-600',
    hide: 'bg-gray-100 text-gray-500', narration: 'bg-slate-100 text-slate-600',
    say: 'bg-amber-100 text-amber-600', thought: 'bg-purple-100 text-purple-600',
    pause: 'bg-orange-100 text-orange-600', transition: 'bg-cyan-100 text-cyan-600',
  }

  switch (tab) {
    case 'script':
      if (!script) return <p className="text-muted-foreground">加载 VN 脚本中...</p>
      return (
        <div className="space-y-1 max-h-[500px] overflow-auto">
          {script.steps.map((step, i) => (
            <div key={step.stepId} className="flex items-start gap-2 px-2 py-1 rounded hover:bg-muted">
              <span className="text-[10px] text-muted-foreground w-5 text-right pt-0.5 shrink-0">{i + 1}</span>
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
          {script.steps.length === 0 && <p className="text-muted-foreground">空脚本（无步骤）</p>}
        </div>
      )

    case 'parsed':
      if (!narrative) return <p className="text-muted-foreground">加载叙事解析结果中...</p>
      return (
        <div className="space-y-2 max-h-[500px] overflow-auto">
          {narrative.units.map((unit, i) => (
            <div key={unit.unitId} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted text-xs">
              <span className="text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
              <span className={`px-1.5 py-0.5 rounded font-medium shrink-0 ${
                unit.type === 'dialogue' ? 'bg-amber-100 text-amber-700' :
                unit.type === 'narration' ? 'bg-slate-100 text-slate-600' :
                unit.type === 'thought' ? 'bg-purple-100 text-purple-600' :
                unit.type === 'action' ? 'bg-green-100 text-green-600' :
                'bg-blue-100 text-blue-600'
              }`}>{unit.type}</span>
              <span className="text-foreground">{(unit as any).originalText ?? (unit as any).text ?? '(无文本)'}</span>
            </div>
          ))}
        </div>
      )

    case 'attribution':
      if (!attribution) return <p className="text-muted-foreground">加载归因结果中...</p>
      return (
        <div className="space-y-3 max-h-[500px] overflow-auto">
          {attribution.characters.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1 font-medium">角色列表</p>
              <div className="flex flex-wrap gap-1 mb-3">
                {attribution.characters.map((c) => (
                  <span key={c.characterId} className="px-2 py-0.5 bg-lavender/10 rounded text-xs">{c.canonicalName || c.characterId}</span>
                ))}
              </div>
            </div>
          )}
          {attribution.units.map((unit, i) => (
            <div key={unit.unitId} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted text-xs">
              <span className="text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
              <span className="px-1.5 py-0.5 rounded bg-lavender/10 text-deep-purple font-medium shrink-0">
                {(unit as any).speaker ?? (unit as any).characterId ?? '未知'}
              </span>
              <span className="text-foreground">{(unit as any).originalText ?? (unit as any).text ?? ''}</span>
            </div>
          ))}
        </div>
      )

    case 'fidelity':
      if (!fidelity) return <p className="text-muted-foreground">加载忠实性报告中...</p>
      return (
        <div className="space-y-2">
          <div className={`text-sm font-medium ${fidelity.passed ? 'text-green-600' : 'text-amber-600'}`}>
            {fidelity.passed ? '✅ 通过' : '⚠️ 存在问题'}
          </div>
          {fidelity.issues.length === 0 ? (
            <p className="text-muted-foreground text-xs">无问题</p>
          ) : (
            <div className="space-y-1 max-h-[400px] overflow-auto">
              {fidelity.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 px-2 py-1.5 rounded bg-destructive/5 text-xs">
                  <span className={`px-1.5 py-0.5 rounded font-medium shrink-0 ${
                    issue.severity === 'critical' ? 'bg-red-100 text-red-600' :
                    issue.severity === 'major' ? 'bg-orange-100 text-orange-600' :
                    'bg-yellow-100 text-yellow-600'
                  }`}>{issue.severity}</span>
                  <span className="text-foreground">{(issue as any).issueType}: {(issue as any).description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )
  }
}
