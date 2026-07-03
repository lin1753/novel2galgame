import { Link } from 'react-router'
import { Plus, Trash2, BookOpen, Sparkles } from 'lucide-react'
import { useProjects, useDeleteProject } from '@/hooks/useProjects'
import { StatusBadge } from '@/components/common/StatusBadge'

export function ProjectListPage() {
  const { data: projects, isLoading } = useProjects()
  const deleteProject = useDeleteProject()

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header with gradient accent */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-sakura" />
            项目列表
          </h1>
          <p className="text-sm text-muted-foreground mt-1">管理你的视觉小说项目</p>
        </div>
        <Link
          to="/projects/new"
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all duration-200 hover:scale-[1.02]"
        >
          <Plus className="w-4 h-4" />
          新建项目
        </Link>
      </div>

      {isLoading && (
        <div className="text-center py-20">
          <div className="w-8 h-8 border-2 border-lavender border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-muted-foreground mt-3">加载中...</p>
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="text-center py-20">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-sakura/20 to-lavender/20 flex items-center justify-center mx-auto mb-4">
            <BookOpen className="w-10 h-10 text-lavender" />
          </div>
          <p className="text-lg font-medium text-deep-purple mb-1">还没有项目</p>
          <p className="text-sm text-muted-foreground">点击"新建项目"开始导入你的第一部小说</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {projects?.map((p) => (
          <div
            key={p.projectId}
            className="border border-border rounded-2xl p-5 bg-card shadow-card hover:shadow-card-hover transition-all duration-200 group hover:border-lavender/40"
          >
            <Link to={`/projects/${p.projectId}/overview`} className="block">
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-deep-purple truncate">{p.title}</h3>
                <StatusBadge status={p.status} />
              </div>
              <div className="text-sm text-muted-foreground space-y-1.5">
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
                className="p-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity rounded-lg hover:bg-destructive/10"
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
