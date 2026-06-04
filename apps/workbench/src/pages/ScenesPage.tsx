import { useState } from 'react'
import { useParams } from 'react-router'
import { useScenes } from '@/hooks/useScenes'
import { StatusBadge } from '@/components/common/StatusBadge'
import type { SceneState } from '@novel2gal/core'

export function ScenesPage() {
  const { projectId, chapterId } = useParams<{ projectId: string; chapterId: string }>()
  const { data: scenes, isLoading } = useScenes(projectId!, chapterId!)
  const [selectedScene, setSelectedScene] = useState<SceneState | null>(null)
  const [activeTab, setActiveTab] = useState<'original' | 'parsed' | 'attribution'>('original')

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Scene List */}
      <aside className="w-60 border-r border-border overflow-auto shrink-0 p-4">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">场景列表 ({scenes?.length ?? 0})</h3>
        {isLoading && <p className="text-sm text-muted-foreground">加载中...</p>}
        <div className="space-y-1">
          {scenes?.map((sc, i) => (
            <button
              key={sc.sceneId}
              onClick={() => setSelectedScene(sc)}
              className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                selectedScene?.sceneId === sc.sceneId
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
              }`}
            >
              <div className="flex items-center justify-between">
                <span>场景 {i + 1}</span>
                <StatusBadge status={sc.status} />
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Center: Content Comparison */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedScene ? (
          <div className="text-center py-20 text-muted-foreground">
            <p>选择一个场景查看详情</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium">场景 {selectedScene.sceneId}</h3>
              <StatusBadge status={selectedScene.status} />
            </div>

            {/* Tab switcher */}
            <div className="flex gap-1 border-b border-border">
              {(['original', 'parsed', 'attribution'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                    activeTab === tab
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab === 'original' ? '原文' : tab === 'parsed' ? '解析' : '归因'}
                </button>
              ))}
            </div>

            <div className="border border-border rounded-lg p-4 min-h-[200px] text-sm">
              <p className="text-muted-foreground">
                {activeTab === 'original' && '原文内容将在 API 路由实现后显示'}
                {activeTab === 'parsed' && '解析结果将在 API 路由实现后显示'}
                {activeTab === 'attribution' && '归因结果将在 API 路由实现后显示'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right: Scene Operations */}
      <aside className="w-56 border-l border-border p-4 shrink-0">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">操作</h3>
        {selectedScene && (
          <div className="space-y-2">
            <button className="w-full px-3 py-2 bg-primary text-primary-foreground rounded text-sm">
              运行 VN 映射
            </button>
            <button className="w-full px-3 py-2 border border-border rounded text-sm hover:bg-secondary">
              查看忠实性报告
            </button>
            <button className="w-full px-3 py-2 border border-border rounded text-sm hover:bg-secondary">
              生成视觉提示
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}
