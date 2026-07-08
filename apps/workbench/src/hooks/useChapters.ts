import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { chapterService } from '@/services/chapters'

export function useChapters(projectId: string) {
  return useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => chapterService.list(projectId),
    enabled: !!projectId,
  })
}

export function useRunChapter(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (chapterId: string) => chapterService.run(projectId, chapterId),
    onSuccess: (data: any) => {
      // Pipeline is now async — response is { chapterId, status: "started" }
      if (data.status === 'started') {
        // Immediately refresh to show "running" status
        qc.invalidateQueries({ queryKey: ['chapters', projectId] })
        return
      }
      qc.invalidateQueries({ queryKey: ['chapters', projectId] })
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
    onError: (err: any) => {
      console.error('[useRunChapter] Error:', err)
      // Only show alert for actual errors (not the async pipeline response)
      if (err.message !== 'started') {
        alert(`管线启动失败: ${err.message}`)
      }
    },
  })
}
