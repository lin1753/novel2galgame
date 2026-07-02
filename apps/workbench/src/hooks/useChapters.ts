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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chapters', projectId] })
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    },
    onError: (err: any) => {
      console.error('[useRunChapter] Error:', err)
      alert(`管线运行失败: ${err.message}`)
    },
  })
}
