import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sceneService } from '@/services/scenes'
import { chapterService } from '@/services/chapters'
import { ScenePreview } from '@/components/editor/ScenePreview'
import { StepTimeline } from '@/components/editor/StepTimeline'
import { PropertiesPanel } from '@/components/editor/PropertiesPanel'
import { Save, Undo2, Redo2, Sparkles, ChevronRight } from 'lucide-react'
import type { VNScript, VNStep } from '@novel2gal/core'

export function EditorPage() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId?: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Scene list for picker
  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => chapterService.list(projectId!),
    enabled: !!projectId && !sceneId,
  })

  const { data: script, isLoading } = useQuery({
    queryKey: ['script', projectId, sceneId],
    queryFn: () => sceneService.getScript(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  })

  const [steps, setSteps] = useState<VNStep[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [history, setHistory] = useState<VNStep[][]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [isDirty, setIsDirty] = useState(false)

  // Load script into state
  useEffect(() => {
    if (script?.steps) {
      setSteps(script.steps)
      setHistory([script.steps])
      setHistoryIndex(0)
      setIsDirty(false)
    }
  }, [script])

  const pushHistory = useCallback((newSteps: VNStep[]) => {
    setHistory(prev => [...prev.slice(0, historyIndex + 1), newSteps])
    setHistoryIndex(prev => prev + 1)
    setIsDirty(true)
  }, [historyIndex])

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      setHistoryIndex(prev => prev - 1)
      setSteps(history[historyIndex - 1])
      setIsDirty(true)
    }
  }, [historyIndex, history])

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(prev => prev + 1)
      setSteps(history[historyIndex + 1])
      setIsDirty(true)
    }
  }, [historyIndex, history])

  const updateStep = useCallback((index: number, updates: Partial<VNStep>) => {
    const newSteps = [...steps]
    newSteps[index] = { ...newSteps[index], ...updates } as VNStep
    setSteps(newSteps)
    pushHistory(newSteps)
  }, [steps, pushHistory])

  const addStep = useCallback((afterIndex: number) => {
    const newStep: VNStep = {
      stepId: `step_editor_${Date.now()}`,
      type: 'narration',
      order: afterIndex + 1,
      text: '',
    } as VNStep
    const newSteps = [...steps]
    newSteps.splice(afterIndex + 1, 0, newStep)
    // Re-index orders
    newSteps.forEach((s, i) => (s as any).order = i)
    setSteps(newSteps)
    setSelectedIndex(afterIndex + 1)
    pushHistory(newSteps)
  }, [steps, pushHistory])

  const deleteStep = useCallback((index: number) => {
    const newSteps = steps.filter((_, i) => i !== index)
    newSteps.forEach((s, i) => (s as any).order = i)
    setSteps(newSteps)
    setSelectedIndex(Math.min(index, newSteps.length - 1))
    pushHistory(newSteps)
  }, [steps, pushHistory])

  const moveStep = useCallback((fromIndex: number, toIndex: number) => {
    const newSteps = [...steps]
    const [moved] = newSteps.splice(fromIndex, 1)
    newSteps.splice(toIndex, 0, moved)
    newSteps.forEach((s, i) => (s as any).order = i)
    setSteps(newSteps)
    setSelectedIndex(toIndex)
    pushHistory(newSteps)
  }, [steps, pushHistory])

  const saveMutation = useMutation({
    mutationFn: () => sceneService.updateScript(projectId!, sceneId!, {
      ...script,
      sceneId: sceneId!,
      steps,
    } as VNScript),
    onSuccess: () => {
      setIsDirty(false)
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] })
    },
  })

  // Scene picker when no sceneId
  if (!sceneId) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-sakura" />
          场景编辑器
        </h1>
        <p className="text-sm text-muted-foreground mb-6">选择一个场景开始编辑</p>
        {chapters?.map((ch) => (
          <ScenePickerChapter key={ch.chapterId} chapter={ch} projectId={projectId!}
            onSelect={(sid) => navigate(`/projects/${projectId}/editor/${sid}`)} />
        ))}
      </div>
    )
  }

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">加载中...</div>
  if (!script) return <div className="p-8 text-center text-muted-foreground">未找到脚本</div>

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="h-12 border-b border-border bg-card flex items-center px-4 gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sakura" />
          <span className="font-semibold text-deep-purple text-sm">场景编辑器</span>
        </div>
        <div className="flex items-center gap-1 ml-4">
          <button onClick={undo} disabled={historyIndex <= 0}
            className="p-1.5 rounded-lg hover:bg-lavender/10 disabled:opacity-30 transition-colors">
            <Undo2 className="w-4 h-4" />
          </button>
          <button onClick={redo} disabled={historyIndex >= history.length - 1}
            className="p-1.5 rounded-lg hover:bg-lavender/10 disabled:opacity-30 transition-colors">
            <Redo2 className="w-4 h-4" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{steps.length} 步骤</span>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-all hover:shadow-md"
          >
            <Save className="w-3.5 h-3.5" />
            {saveMutation.isPending ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* Main content: 3-panel layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Scene Preview */}
        <div className="w-[420px] border-r border-border shrink-0">
          <ScenePreview steps={steps} currentIndex={selectedIndex} />
        </div>

        {/* Center: Step Timeline */}
        <div className="flex-1 min-w-0">
          <StepTimeline
            steps={steps}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onAdd={addStep}
            onDelete={deleteStep}
            onMove={moveStep}
          />
        </div>

        {/* Right: Properties Panel */}
        <div className="w-72 border-l border-border shrink-0">
          <PropertiesPanel
            step={steps[selectedIndex]}
            stepIndex={selectedIndex}
            onUpdate={(updates) => updateStep(selectedIndex, updates)}
          />
        </div>
      </div>
    </div>
  )
}

function ScenePickerChapter({ chapter, projectId, onSelect }: { chapter: any; projectId: string; onSelect: (sceneId: string) => void }) {
  const { data: scenes } = useQuery({
    queryKey: ['scenes', projectId, chapter.chapterId],
    queryFn: () => sceneService.listByChapter(projectId, chapter.chapterId),
    enabled: !!projectId && !!chapter.chapterId,
  })

  if (!scenes || scenes.length === 0) return null

  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-deep-purple mb-2">{chapter.title}</h3>
      <div className="grid grid-cols-2 gap-2">
        {scenes.map((scene) => (
          <button
            key={scene.sceneId}
            onClick={() => onSelect(scene.sceneId)}
            className="text-left px-3 py-2 rounded-xl border border-border bg-card hover:border-lavender/40 hover:shadow-card transition-all text-sm"
          >
            <span className="text-foreground">{scene.sceneId.split('_').pop()}</span>
            <span className="text-muted-foreground ml-2 text-xs">{scene.status}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
