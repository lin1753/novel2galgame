import { useQuery } from '@tanstack/react-query'
import { sceneService } from '@/services/scenes'

export function useScenes(projectId: string, chapterId: string) {
  return useQuery({
    queryKey: ['scenes', chapterId],
    queryFn: () => sceneService.listByChapter(projectId, chapterId),
    enabled: !!projectId && !!chapterId,
  })
}

export function useSceneScript(projectId: string, sceneId: string) {
  return useQuery({
    queryKey: ['script', sceneId],
    queryFn: () => sceneService.getScript(projectId, sceneId),
    enabled: !!projectId && !!sceneId,
  })
}

export function useFidelityReport(projectId: string, sceneId: string) {
  return useQuery({
    queryKey: ['fidelity', sceneId],
    queryFn: () => sceneService.getFidelity(projectId, sceneId),
    enabled: !!projectId && !!sceneId,
  })
}
