import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, FileText, Layers, Eye, ListTodo, Download, Sparkles, Package, Zap, XCircle, StopCircle, CheckCircle2, Clock, AlertCircle, Loader2 } from 'lucide-react'
import { useProject, useRunStructure } from '@/hooks/useProjects'
import { useChapters } from '@/hooks/useChapters'
import { useAutoExport } from '@/hooks/useAutoExport'
import type { ChapterProgress } from '@/store/autoExportStore'
import { projectService } from '@/services/projects'
import { StatusBadge } from '@/components/common/StatusBadge'
import type { ProjectState } from '@novel2gal/core'

export function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const queryClient = useQueryClient()
  const { data: project } = useProject(projectId!)
  const { data: chapters } = useChapters(projectId!)
  const runStructure = useRunStructure(projectId!)

  const [exportOutput, setExportOutput] = useState<{ success: boolean; outputPath?: string; message: string } | null>(null)
  const {
    running: autoExportRunning,
    logs: autoExportLog,
    chapterList,
    stats,
    exportOutput: autoExportOutput,
    startAutoExport,
    cancelChapter,
    cancelAll,
  } = useAutoExport(projectId!)

  const exportRenpy = useMutation({
    mutationFn: () => projectService.exportRenpy(projectId!),
    onMutate: () => setExportOutput({ success: false, message: '导出中...' }),
    onSuccess: (data) => setExportOutput({
      success: data.success,
      outputPath: data.outputPath,
      message: `导出成功: ${data.stats?.generatedFiles?.length ?? 0} 文件`,
    }),
    onError: (err: any) => setExportOutput({ success: false, message: `导出失败: ${err.message}` }),
  })

  const generateAssets = useMutation({
    mutationFn: () => projectService.generateAssets(projectId!),
    onMutate: () => setExportOutput({ success: false, message: '生成资源中...' }),
    onSuccess: (data) => setExportOutput({ success: true, message: `生成完成: ${data.generated?.length ?? 0} 张图片` }),
    onError: (err: any) => setExportOutput({ success: false, message: `生成失败: ${err.message}` }),
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
          <Link to={`/projects/${projectId}/assets`}
            className="flex items-center gap-2 px-4 py-2 border border-lavender/30 text-deep-purple rounded-xl hover:bg-lavender/10 transition-all">
            <Package className="w-4 h-4" /> 资产管理
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
          <div className="w-full border-t border-border my-2" />
          <button onClick={() => startAutoExport({ maxChapters: Infinity })} disabled={autoExportRunning}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-violet-500 to-purple-600 text-white rounded-xl font-medium disabled:opacity-50 transition-all hover:shadow-lg">
            <Zap className="w-4 h-4" />
            {autoExportRunning ? '处理中...' : '一键处理 (管线→导出)'}
          </button>
          {exportOutput && (
            <div className="w-full">
              <div className={`flex items-center gap-2 text-sm ${exportOutput.success ? 'text-emerald-500' : 'text-red-400'}`}>
                {exportOutput.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                {exportOutput.message}
              </div>
              {exportOutput.outputPath && (
                <p className="text-xs text-muted-foreground mt-0.5 ml-6 font-mono">{exportOutput.outputPath}</p>
              )}
            </div>
          )}
        </div>

        {/* Chapter-level progress panel */}
        {autoExportRunning && (
          <div className="mt-4 border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
              <span className="text-sm font-medium text-deep-purple">批量处理进度</span>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" /> {stats.completed}</span>
                <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 text-blue-500 animate-spin" /> {stats.running}</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-muted-foreground" /> {stats.queued}</span>
                <span className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-red-500" /> {stats.failed}</span>
                <span className="flex items-center gap-1"><XCircle className="w-3 h-3 text-gray-500" /> {stats.cancelled}</span>
                <button onClick={cancelAll} className="text-red-400 hover:text-red-300 ml-2 flex items-center gap-1">
                  <StopCircle className="w-3 h-3" /> 全部取消
                </button>
              </div>
            </div>
            <div className="max-h-60 overflow-y-auto">
              {chapterList.map((ch) => (
                <ChapterProgressRow key={ch.chapterId} progress={ch} onCancel={cancelChapter} />
              ))}
              {chapterList.length === 0 && (
                <p className="text-xs text-muted-foreground p-4">等待章节开始处理...</p>
              )}
            </div>
          </div>
        )}

        {/* Auto-export completion result */}
        {autoExportOutput && !autoExportRunning && (
          <div className="mt-4 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
            <div className="flex items-center gap-2 text-sm">
              {autoExportOutput.success ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="font-medium text-emerald-400">一键处理完成</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-red-400" />
                  <span className="font-medium text-red-400">一键处理失败</span>
                </>
              )}
            </div>
            {autoExportOutput.outputPath && (
              <p className="text-xs text-muted-foreground mt-1 ml-6 font-mono">{autoExportOutput.outputPath}</p>
            )}
          </div>
        )}

        {/* Simple log panel (collapsible) */}
        {autoExportLog.length > 0 && (
          <div className="mt-4 rounded-xl bg-gray-900 p-3 max-h-40 overflow-y-auto font-mono text-xs">
            {autoExportLog.slice(-50).map((line, i) => (
              <p key={i} className="text-green-400">{line}</p>
            ))}
            {autoExportRunning && <p className="text-yellow-400 animate-pulse">处理中...</p>}
          </div>
        )}
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

function ChapterProgressRow({ progress, onCancel }: { progress: ChapterProgress; onCancel: (id: string) => void }) {
  const statusIcon = () => {
    switch (progress.status) {
      case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
      case 'running': return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
      case 'failed': return <AlertCircle className="w-3.5 h-3.5 text-red-400" />
      case 'cancelled': return <XCircle className="w-3.5 h-3.5 text-gray-400" />
      case 'queued': return <Clock className="w-3.5 h-3.5 text-muted-foreground" />
    }
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-border/50 last:border-0 hover:bg-muted/30">
      {statusIcon()}
      <span className="font-medium w-20 shrink-0">Ch{progress.chapterIndex + 1}</span>
      <span className="text-muted-foreground flex-1 truncate">{progress.stage}{progress.message ? `: ${progress.message}` : ''}</span>
      {progress.status === 'running' && (
        <button onClick={() => onCancel(progress.chapterId)} className="text-red-400 hover:text-red-300 shrink-0">
          <XCircle className="w-3 h-3" />
        </button>
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
