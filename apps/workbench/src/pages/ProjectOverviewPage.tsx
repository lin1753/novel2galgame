import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, FileText, Layers, Eye, ListTodo, Download, Sparkles, Package, ExternalLink } from 'lucide-react'
import { useProject, useRunStructure } from '@/hooks/useProjects'
import { useChapters } from '@/hooks/useChapters'
import { projectService } from '@/services/projects'
import { StatusBadge } from '@/components/common/StatusBadge'

export function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const queryClient = useQueryClient()
  const { data: project } = useProject(projectId!)
  const { data: chapters } = useChapters(projectId!)
  const runStructure = useRunStructure(projectId!)

  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const exportRenpy = useMutation({
    mutationFn: () => projectService.exportRenpy(projectId!),
    onMutate: () => setExportStatus('exporting'),
    onSuccess: (data) => setExportStatus(`导出成功: ${data.stats?.generatedFiles?.length ?? 0} 文件`),
    onError: (err: any) => setExportStatus(`导出失败: ${err.message}`),
  })

  const generateAssets = useMutation({
    mutationFn: () => projectService.generateAssets(projectId!),
    onMutate: () => setExportStatus('生成资源中...'),
    onSuccess: (data) => setExportStatus(`生成完成: ${data.generated?.length ?? 0} 张图片`),
    onError: (err: any) => setExportStatus(`生成失败: ${err.message}`),
  })

  if (!project) return <div className="p-6 text-muted-foreground">加载中...</div>

  const failedChapters = chapters?.filter((c) => c.status === 'failed') ?? []
  const readyChapters = chapters?.filter((c) => c.status === 'chapter_ready') ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-sakura" />
          {project.title}
        </h2>
        <StatusBadge status={project.status} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoCard label="原始文件" value={project.sourceFileName || '未导入'} />
        <InfoCard label="总章节数" value={String(project.totalChapters)} />
        <InfoCard label="已完成" value={`${readyChapters.length}`} />
        <InfoCard label="失败" value={`${failedChapters.length}`} accent={failedChapters.length > 0} />
      </div>

      {/* Quick Actions */}
      <div className="border border-border rounded-2xl p-5 bg-card shadow-card">
        <h3 className="font-semibold text-deep-purple mb-3 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sakura" /> 快捷操作
        </h3>
        <div className="flex flex-wrap gap-3">
          {project.status === 'created' && (
            <button onClick={() => runStructure.mutate()} disabled={runStructure.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl font-medium disabled:opacity-50 transition-all hover:shadow-md">
              <Play className="w-4 h-4" />
              {runStructure.isPending ? '解析中...' : '运行结构解析'}
            </button>
          )}
          {project.status === 'structured' && (
            <Link to={`/projects/${projectId}/chapters`}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl font-medium transition-all hover:shadow-md">
              <FileText className="w-4 h-4" /> 进入章节管理
            </Link>
          )}
          <Link to={`/projects/${projectId}/editor`}
            className="flex items-center gap-2 px-4 py-2 border border-lavender/30 text-deep-purple rounded-xl hover:bg-lavender/10 transition-all">
            <Sparkles className="w-4 h-4" /> 场景编辑器
          </Link>
          <Link to={`/projects/${projectId}/preview`}
            className="flex items-center gap-2 px-4 py-2 border border-lavender/30 text-deep-purple rounded-xl hover:bg-lavender/10 transition-all">
            <Eye className="w-4 h-4" /> 预览
          </Link>

          {/* Export Section */}
          <div className="w-full border-t border-border my-2" />
          <button onClick={() => exportRenpy.mutate()} disabled={exportRenpy.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-400 to-teal-400 text-white rounded-xl font-medium disabled:opacity-50 transition-all hover:shadow-md">
            <Download className="w-4 h-4" />
            {exportRenpy.isPending ? '导出中...' : '导出 Ren\'Py 项目'}
          </button>
          <button onClick={() => generateAssets.mutate()} disabled={generateAssets.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-amber-400 to-orange-400 text-white rounded-xl font-medium disabled:opacity-50 transition-all hover:shadow-md">
            <Package className="w-4 h-4" />
            {generateAssets.isPending ? '生成中...' : '生成背景/立绘'}
          </button>
          {exportStatus && (
            <span className="text-sm text-muted-foreground self-center">{exportStatus}</span>
          )}
        </div>
      </div>

      {failedChapters.length > 0 && (
        <div className="border border-destructive/50 rounded-2xl p-4 bg-destructive/5">
          <h3 className="font-medium text-destructive mb-2">异常章节</h3>
          <ul className="text-sm space-y-1">
            {failedChapters.map((ch) => (
              <li key={ch.chapterId}>第{ch.index + 1}章 {ch.title}: {ch.lastError || '处理失败'}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function InfoCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border border-border rounded-2xl p-4 bg-card shadow-card">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-semibold ${accent ? 'text-destructive' : 'text-deep-purple'}`}>{value}</p>
    </div>
  )
}
