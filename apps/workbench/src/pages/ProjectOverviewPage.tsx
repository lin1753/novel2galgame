import { useParams, Link } from 'react-router'
import { Play, FileText, Layers, Eye, ListTodo } from 'lucide-react'
import { useProject, useRunStructure } from '@/hooks/useProjects'
import { useChapters } from '@/hooks/useChapters'
import { StatusBadge } from '@/components/common/StatusBadge'

export function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: project } = useProject(projectId!)
  const { data: chapters } = useChapters(projectId!)
  const runStructure = useRunStructure(projectId!)

  if (!project) return <div className="p-6 text-muted-foreground">加载中...</div>

  const failedChapters = chapters?.filter((c) => c.status === 'failed') ?? []
  const readyChapters = chapters?.filter((c) => c.status === 'chapter_ready') ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">{project.title}</h2>
        <StatusBadge status={project.status} />
      </div>

      {/* Module A: Project Info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoCard label="原始文件" value={project.sourceFileName || '未导入'} />
        <InfoCard label="总章节数" value={String(project.totalChapters)} />
        <InfoCard label="已完成" value={`${readyChapters.length}`} />
        <InfoCard label="失败" value={`${failedChapters.length}`} accent={failedChapters.length > 0} />
      </div>

      {/* Module C: Quick Actions */}
      <div className="border border-border rounded-lg p-4">
        <h3 className="font-medium mb-3">快捷操作</h3>
        <div className="flex flex-wrap gap-3">
          {project.status === 'created' && (
            <button
              onClick={() => runStructure.mutate()}
              disabled={runStructure.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {runStructure.isPending ? '解析中...' : '运行结构解析'}
            </button>
          )}
          {project.status === 'structured' && (
            <Link to={`/projects/${projectId}/chapters`} className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded hover:opacity-90">
              <FileText className="w-4 h-4" /> 进入章节管理
            </Link>
          )}
          <Link to={`/projects/${projectId}/chapters`} className="flex items-center gap-2 px-4 py-2 border border-border rounded hover:bg-secondary">
            <Layers className="w-4 h-4" /> 章节列表
          </Link>
          <Link to={`/projects/${projectId}/preview`} className="flex items-center gap-2 px-4 py-2 border border-border rounded hover:bg-secondary">
            <Eye className="w-4 h-4" /> 预览
          </Link>
          <Link to={`/projects/${projectId}/tasks`} className="flex items-center gap-2 px-4 py-2 border border-border rounded hover:bg-secondary">
            <ListTodo className="w-4 h-4" /> 任务日志
          </Link>
        </div>
      </div>

      {/* Module D: Alerts */}
      {failedChapters.length > 0 && (
        <div className="border border-destructive/50 rounded-lg p-4 bg-destructive/10">
          <h3 className="font-medium text-destructive mb-2">异常章节</h3>
          <ul className="text-sm space-y-1">
            {failedChapters.map((ch) => (
              <li key={ch.chapterId}>
                第{ch.index + 1}章 {ch.title}: {ch.lastError || '处理失败'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function InfoCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border border-border rounded-lg p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-semibold ${accent ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  )
}
