import { Link } from 'react-router'
import { Plus, Trash2, FolderOpen } from 'lucide-react'
import { useProjects, useDeleteProject } from '@/hooks/useProjects'
import { StatusBadge } from '@/components/common/StatusBadge'

export function ProjectListPage() {
  const { data: projects, isLoading } = useProjects()
  const deleteProject = useDeleteProject()

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">项目列表</h1>
        <Link
          to="/projects/new"
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          新建项目
        </Link>
      </div>

      {isLoading && <p className="text-muted-foreground">加载中...</p>}

      {projects && projects.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg mb-2">还没有项目</p>
          <p className="text-sm">点击"新建项目"开始导入你的第一部小说</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects?.map((p) => (
          <div
            key={p.projectId}
            className="border border-border rounded-lg p-4 hover:border-primary/50 transition-colors group"
          >
            <Link to={`/projects/${p.projectId}/overview`} className="block">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium truncate">{p.title}</h3>
                <StatusBadge status={p.status} />
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>文件: {p.sourceFileName || '未导入'}</p>
                <p>章节: {p.readyChapters}/{p.totalChapters} 已完成</p>
                <p>创建: {new Date(p.createdAt).toLocaleDateString('zh-CN')}</p>
              </div>
            </Link>
            <div className="mt-3 flex justify-end">
              <button
                onClick={(e) => {
                  e.preventDefault()
                  if (confirm('确认删除该项目?')) deleteProject.mutate(p.projectId)
                }}
                className="p-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
