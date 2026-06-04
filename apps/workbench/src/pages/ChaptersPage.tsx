import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { Play, RotateCcw, Layers, Loader2 } from 'lucide-react'
import { useChapters, useRunChapter } from '@/hooks/useChapters'
import { StatusBadge } from '@/components/common/StatusBadge'
import { PipelineProgress } from '@/components/common/PipelineProgress'

export function ChaptersPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { data: chapters, isLoading } = useChapters(projectId!)
  const runChapter = useRunChapter(projectId!)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = chapters?.find((c) => c.chapterId === selectedId)

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Chapter List */}
      <aside className="w-72 border-r border-border overflow-auto shrink-0 p-4">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">章节列表 ({chapters?.length ?? 0})</h3>
        {isLoading && <p className="text-sm text-muted-foreground">加载中...</p>}
        <div className="space-y-1">
          {chapters?.map((ch) => (
            <button
              key={ch.chapterId}
              onClick={() => setSelectedId(ch.chapterId)}
              className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                selectedId === ch.chapterId
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">第{ch.index + 1}章 {ch.title}</span>
                <StatusBadge status={ch.status} />
              </div>
              {ch.sceneIds.length > 0 && (
                <span className="text-xs text-muted-foreground">{ch.sceneIds.length} 场景</span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* Center: Chapter Detail */}
      <div className="flex-1 overflow-auto p-4">
        {!selected ? (
          <div className="text-center py-20 text-muted-foreground">
            <Layers className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p>选择一个章节查看详情</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium">第{selected.index + 1}章 {selected.title}</h3>
              <StatusBadge status={selected.status} />
            </div>

            <PipelineProgress status={selected.status} />

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="border border-border rounded p-2">
                <p className="text-muted-foreground">解析</p>
                <p>{selected.parsingDone ? '完成' : '未完成'}</p>
              </div>
              <div className="border border-border rounded p-2">
                <p className="text-muted-foreground">归因</p>
                <p>{selected.attributionDone ? '完成' : '未完成'}</p>
              </div>
              <div className="border border-border rounded p-2">
                <p className="text-muted-foreground">分镜</p>
                <p>{selected.segmentationDone ? '完成' : '未完成'}</p>
              </div>
            </div>

            {selected.sceneIds.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">场景列表 ({selected.sceneIds.length})</p>
                <button
                  onClick={() => navigate(`/projects/${projectId}/scenes/${selected.chapterId}`)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded hover:bg-secondary"
                >
                  <Layers className="w-3.5 h-3.5" /> 查看场景工作区
                </button>
              </div>
            )}

            {selected.lastError && (
              <div className="border border-destructive/50 rounded p-3 bg-destructive/10 text-sm">
                <p className="font-medium text-destructive mb-1">错误信息</p>
                <p>{selected.lastError}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: Operations */}
      <aside className="w-56 border-l border-border p-4 shrink-0">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">操作</h3>
        {selected && (
          <div className="space-y-2">
            <button
              onClick={() => runChapter.mutate(selected.chapterId)}
              disabled={runChapter.isPending}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
            >
              {runChapter.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {selected.status === 'failed' ? '重新运行' : '运行管线'}
            </button>
            {selected.sceneIds.length > 0 && (
              <button
                onClick={() => navigate(`/projects/${projectId}/scenes/${selected.chapterId}`)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-border rounded text-sm hover:bg-secondary"
              >
                <Layers className="w-4 h-4" /> 查看场景
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
