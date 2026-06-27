import { useState } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { chapterService } from '@/services/chapters'
import { sceneService } from '@/services/scenes'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Layers, Sparkles } from 'lucide-react'
import type { SceneState, ChapterState } from '@novel2gal/core'

export function ScenesPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [selectedScene, setSelectedScene] = useState<SceneState | null>(null)
  const [activeTab, setActiveTab] = useState<'original' | 'parsed' | 'attribution'>('original')

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

  // Auto-select first chapter with scenes
  if (!selectedChapterId && chapters && chapters.length > 0) {
    const withScenes = chapters.find((c: any) => c.sceneIds && c.sceneIds.length > 0)
    if (withScenes) setSelectedChapterId(withScenes.chapterId)
  }

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Chapter + Scene List */}
      <aside className="w-60 border-r border-border overflow-auto shrink-0 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-sakura" />
          <h3 className="font-medium text-sm text-deep-purple">章节/场景</h3>
        </div>

        {chapters?.filter((c: any) => c.sceneIds && c.sceneIds.length > 0).map((ch: ChapterState) => (
          <div key={ch.chapterId} className="mb-3">
            <button
              onClick={() => { setSelectedChapterId(ch.chapterId); setSelectedScene(null) }}
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
              {(['original', 'parsed', 'attribution'] as const).map((tab) => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                    activeTab === tab ? 'border-lavender text-deep-purple font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}>
                  {tab === 'original' ? '原文' : tab === 'parsed' ? '解析' : '归因'}
                </button>
              ))}
            </div>

            <div className="border border-border rounded-xl p-4 min-h-[200px] text-sm bg-card">
              <p className="text-muted-foreground">
                {activeTab === 'original' && '原文内容将在 API 路由实现后显示'}
                {activeTab === 'parsed' && '解析结果将在 API 路由实现后显示'}
                {activeTab === 'attribution' && '归因结果将在 API 路由实现后显示'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right: Operations */}
      <aside className="w-56 border-l border-border p-4 shrink-0">
        <h3 className="font-medium mb-3 text-sm text-deep-purple">操作</h3>
        {selectedScene && (
          <div className="space-y-2">
            <button className="w-full px-3 py-2 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl text-sm font-medium">
              运行 VN 映射
            </button>
            <button className="w-full px-3 py-2 border border-border rounded-xl text-sm hover:bg-muted">
              查看忠实性报告
            </button>
            <button className="w-full px-3 py-2 border border-border rounded-xl text-sm hover:bg-muted">
              生成视觉提示
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}
