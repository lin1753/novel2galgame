import { useQuery } from '@tanstack/react-query'
import { taskService } from '@/services/tasks'

export function useTasks(projectId: string) {
  return useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => taskService.list(projectId),
    enabled: !!projectId,
    refetchInterval: 5000,
  })
}
