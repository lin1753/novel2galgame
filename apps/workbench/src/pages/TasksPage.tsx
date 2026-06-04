import { useParams } from 'react-router'
import { useTasks } from '@/hooks/useTasks'
import type { TaskStatus } from '@novel2gal/core'

const statusColors: Record<TaskStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-yellow-400',
  succeeded: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-muted-foreground',
}

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: tasks, isLoading } = useTasks(projectId!)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">任务日志</h2>
      {isLoading && <p className="text-muted-foreground text-sm">加载中...</p>}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary">
            <tr>
              <th className="text-left px-3 py-2 font-medium">类型</th>
              <th className="text-left px-3 py-2 font-medium">状态</th>
              <th className="text-left px-3 py-2 font-medium">章节</th>
              <th className="text-left px-3 py-2 font-medium">开始时间</th>
              <th className="text-left px-3 py-2 font-medium">耗时</th>
            </tr>
          </thead>
          <tbody>
            {tasks?.map((t) => (
              <tr key={t.taskId} className="border-t border-border">
                <td className="px-3 py-2">{t.type}</td>
                <td className={`px-3 py-2 ${statusColors[t.status]}`}>{t.status}</td>
                <td className="px-3 py-2 text-muted-foreground">{t.chapterId ?? '-'}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {t.startedAt ? new Date(t.startedAt).toLocaleString('zh-CN') : '-'}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {t.startedAt && t.finishedAt
                    ? `${((new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime()) / 1000).toFixed(1)}s`
                    : '-'}
                </td>
              </tr>
            ))}
            {tasks?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">暂无任务</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
