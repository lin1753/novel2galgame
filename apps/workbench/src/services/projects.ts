import { request } from './api'
import type { ProjectState, ProjectConfig } from '@novel2gal/core'

export interface CreateProjectBody {
  title?: string
  config?: Partial<ProjectConfig>
}

export interface StructureRunResult {
  bookTitle?: string
  chapterCount: number
  confidence: number
  warnings?: string[]
  chapters: Array<{
    chapterId: string
    index: number
    title: string
    charCount: number
    isExtra?: boolean
    isAfterword?: boolean
  }>
}

export const projectService = {
  list: () => request<ProjectState[]>('/projects'),

  get: (id: string) => request<ProjectState>(`/projects/${id}`),

  create: (body: CreateProjectBody) =>
    request<ProjectState>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  delete: (id: string) =>
    request<void>(`/projects/${id}`, { method: 'DELETE' }),

  import: (id: string, file: File, displayName?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (displayName) form.append('displayName', displayName)
    return request<{ message: string; path: string }>(`/projects/${id}/import`, {
      method: 'POST',
      headers: {},
      body: form,
    })
  },

  runStructure: (id: string) =>
    request<StructureRunResult>(`/projects/${id}/structure/run`, { method: 'POST' }),

  getStructure: (id: string) =>
    request<Record<string, unknown>>(`/projects/${id}/structure`),

  exportRenpy: (id: string) =>
    request<{ success: boolean; outputPath: string; stats: any }>(`/projects/${id}/export/renpy`, {
      method: 'POST',
    }),

  generateAssets: (id: string) =>
    request<{ success: boolean; generated: string[]; errors: string[] }>(`/projects/${id}/export/generate-assets`, {
      method: 'POST',
    }),

  autoExport: (id: string, body?: { model?: string; maxChapters?: number; generateAssets?: boolean }) =>
    request<{ status: string; projectId: string; taskId?: string }>(`/projects/${id}/auto-export`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  cancelAutoExportChapter: (id: string, chapterId: string) =>
    request<void>(`/projects/${id}/auto-export/cancel/${chapterId}`, { method: 'POST' }),

  cancelAllAutoExport: (id: string) =>
    request<void>(`/projects/${id}/auto-export/cancel`, { method: 'POST' }),
}
