import { useState } from 'react'
import { useParams } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sceneService } from '@/services/scenes'
import { chapterService } from '@/services/chapters'
import type { VisualPromptResult, CharacterPromptPack } from '@novel2gal/core'
import { Wand2, Eye, Image, Loader2 } from 'lucide-react'

const STYLE_OPTIONS = [
  { value: 'school-romance-anime', label: '校园恋爱 (动漫)' },
  { value: 'urban-romance', label: '都市恋爱 (写实)' },
  { value: 'fresh-japanese', label: '清新日系' },
]

export function VisualPromptPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const qc = useQueryClient()
  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => chapterService.list(projectId!),
    enabled: !!projectId,
  })

  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [styleTemplate, setStyleTemplate] = useState('school-romance-anime')

  const { data: scenes } = useQuery({
    queryKey: ['scenes', selectedChapterId],
    queryFn: () => sceneService.listByChapter(projectId!, selectedChapterId!),
    enabled: !!projectId && !!selectedChapterId,
  })

  const { data: vpResult, isLoading: vpLoading } = useQuery({
    queryKey: ['visual-prompt', selectedSceneId],
    queryFn: () => sceneService.getVisualPrompt(projectId!, selectedSceneId!),
    enabled: !!projectId && !!selectedSceneId,
  })

  const runVPMutation = useMutation({
    mutationFn: () => sceneService.runVisualPrompt(projectId!, selectedSceneId!, { styleTemplate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visual-prompt', selectedSceneId] }),
  })

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Chapter/Scene nav */}
      <aside className="w-52 border-r border-border overflow-auto shrink-0 p-4">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">场景选择</h3>
        <div className="space-y-1">
          {chapters?.slice(0, 20).map((ch) => (
            <div key={ch.chapterId}>
              <button
                onClick={() => {
                  setSelectedChapterId(ch.chapterId)
                  setSelectedSceneId(null)
                }}
                className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                  selectedChapterId === ch.chapterId
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {ch.title}
              </button>
              {selectedChapterId === ch.chapterId && scenes && (
                <div className="ml-3 space-y-0.5 mt-0.5">
                  {scenes.map((sc, i) => (
                    <button
                      key={sc.sceneId}
                      onClick={() => setSelectedSceneId(sc.sceneId)}
                      className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                        selectedSceneId === sc.sceneId
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      场景 {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* Center: Visual Prompt content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedSceneId ? (
          <div className="text-center py-20 text-muted-foreground">
            <Image className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>选择场景查看视觉提示词</p>
          </div>
        ) : vpLoading ? (
          <div className="text-center py-20 text-muted-foreground">
            <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
            <p>加载中...</p>
          </div>
        ) : !vpResult ? (
          <div className="text-center py-20 text-muted-foreground">
            <Wand2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="mb-4">该场景尚未生成视觉提示词</p>
            <button
              onClick={() => runVPMutation.mutate()}
              disabled={runVPMutation.isPending}
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
            >
              {runVPMutation.isPending ? '生成中...' : '生成视觉提示词'}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium">视觉提示词</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{vpResult.styleTemplate}</span>
                <button
                  onClick={() => runVPMutation.mutate()}
                  disabled={runVPMutation.isPending}
                  className="px-3 py-1.5 border border-border rounded text-xs hover:bg-secondary disabled:opacity-50"
                >
                  {runVPMutation.isPending ? '重新生成中...' : '重新生成'}
                </button>
              </div>
            </div>

            {/* Character Prompts */}
            {vpResult.characterPrompts.length > 0 && (
              <section>
                <h4 className="text-sm font-medium text-muted-foreground mb-3">角色提示词</h4>
                <div className="grid gap-4">
                  {vpResult.characterPrompts.map((cp) => (
                    <CharacterPromptCard
                      key={cp.characterId}
                      pack={cp}
                      projectId={projectId!}
                      sceneId={selectedSceneId!}
                      onSaved={() => qc.invalidateQueries({ queryKey: ['visual-prompt', selectedSceneId] })}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Background Prompt */}
            {vpResult.backgroundPrompt && (
              <BackgroundPromptCard
                backgroundPrompt={vpResult.backgroundPrompt}
                projectId={projectId!}
                sceneId={selectedSceneId!}
                onSaved={() => qc.invalidateQueries({ queryKey: ['visual-prompt', selectedSceneId] })}
              />
            )}
          </div>
        )}
      </div>

      {/* Right: Style & actions */}
      <aside className="w-56 border-l border-border p-4 shrink-0">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">风格设置</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">视觉风格模板</label>
            <select
              value={styleTemplate}
              onChange={(e) => setStyleTemplate(e.target.value)}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm"
            >
              {STYLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {selectedSceneId && (
            <button
              onClick={() => runVPMutation.mutate()}
              disabled={runVPMutation.isPending}
              className="w-full px-3 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {runVPMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4" />
              )}
              生成视觉提示
            </button>
          )}

          {runVPMutation.isError && (
            <p className="text-xs text-destructive">
              {runVPMutation.error instanceof Error ? runVPMutation.error.message : '生成失败'}
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

function CharacterPromptCard({
  pack,
  projectId,
  sceneId,
  onSaved,
}: {
  pack: CharacterPromptPack
  projectId: string
  sceneId: string
  onSaved: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [editing, setEditing] = useState(false)
  const [promptText, setPromptText] = useState(pack.finalPrompt)

  const saveMutation = useMutation({
    mutationFn: () =>
      sceneService.updateVisualPrompt(projectId, sceneId, {
        characterId: pack.characterId,
        finalPrompt: promptText,
      }),
    onSuccess: () => {
      setEditing(false)
      onSaved()
    },
  })

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-xs text-primary font-medium">
            {pack.canonicalName[0]}
          </div>
          <div className="text-left">
            <p className="text-sm font-medium">{pack.canonicalName}</p>
            <p className="text-xs text-muted-foreground">{pack.characterId}</p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-border">
          {/* Evidence */}
          {pack.evidence.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">原文证据:</p>
              {pack.evidence.map((ev, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                    {ev.category}
                  </span>
                  <span className="italic text-slate-400">"{ev.quote}"</span>
                </div>
              ))}
            </div>
          )}

          {/* Conservative Completion */}
          {pack.conservativeCompletion && pack.conservativeCompletion.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">保守补全:</p>
              <div className="flex flex-wrap gap-1">
                {pack.conservativeCompletion.map((item, i) => (
                  <span key={i} className="px-2 py-0.5 bg-muted rounded text-xs">{item}</span>
                ))}
              </div>
            </div>
          )}

          {/* Final Prompt with Inline Edit */}
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">最终 Prompt (可自定义修改):</p>
              <button
                onClick={() => {
                  if (editing) saveMutation.mutate()
                  else setEditing(true)
                }}
                disabled={saveMutation.isPending}
                className="text-xs text-primary hover:underline"
              >
                {saveMutation.isPending ? '保存中...' : editing ? '保存修改' : '编辑'}
              </button>
            </div>
            {editing ? (
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                className="w-full h-24 text-xs bg-background border border-border p-2 rounded font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <p className="text-sm bg-muted p-2 rounded font-mono select-all">
                {pack.finalPrompt}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function BackgroundPromptCard({
  backgroundPrompt,
  projectId,
  sceneId,
  onSaved,
}: {
  backgroundPrompt: any
  projectId: string
  sceneId: string
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [promptText, setPromptText] = useState(backgroundPrompt.finalPrompt)

  const saveMutation = useMutation({
    mutationFn: () =>
      sceneService.updateVisualPrompt(projectId, sceneId, {
        backgroundFinalPrompt: promptText,
      }),
    onSuccess: () => {
      setEditing(false)
      onSaved()
    },
  })

  return (
    <section>
      <h4 className="text-sm font-medium text-muted-foreground mb-3">背景提示词</h4>
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">背景</span>
        </div>

        {backgroundPrompt.evidence?.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">原文证据:</p>
            {backgroundPrompt.evidence.map((ev: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                  {ev.category}
                </span>
                <span className="italic text-slate-400">"{ev.quote}"</span>
              </div>
            ))}
          </div>
        )}

        <div className="pt-2 border-t border-border">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground">最终 Prompt (可自定义修改):</p>
            <button
              onClick={() => {
                if (editing) saveMutation.mutate()
                else setEditing(true)
              }}
              disabled={saveMutation.isPending}
              className="text-xs text-primary hover:underline"
            >
              {saveMutation.isPending ? '保存中...' : editing ? '保存修改' : '编辑'}
            </button>
          </div>
          {editing ? (
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              className="w-full h-24 text-xs bg-background border border-border p-2 rounded font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <p className="text-sm bg-muted p-2 rounded font-mono select-all">
              {backgroundPrompt.finalPrompt}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
