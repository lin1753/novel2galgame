import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { projectService } from '@/services/projects'
import type { CreateProjectBody } from '@/services/projects'

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: projectService.list })
}

export function useProject(id: string) {
  return useQuery({ queryKey: ['project', id], queryFn: () => projectService.get(id), enabled: !!id })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateProjectBody) => projectService.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => projectService.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useImportFile(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => projectService.import(projectId, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })
}

export function useRunStructure(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => projectService.runStructure(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['chapters', projectId] })
    },
  })
}
