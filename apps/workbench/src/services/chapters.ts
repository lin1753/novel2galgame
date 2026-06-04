import { request } from './api'
import type { ChapterState } from '@novel2gal/core'

export interface ChapterPipelineResult {
  chapterId: string
  sceneCount: number
  fidelityResults: unknown[]
  characters: unknown[]
}

export const chapterService = {
  list: (projectId: string) =>
    request<ChapterState[]>(`/projects/${projectId}/chapters`),

  run: (projectId: string, chapterId: string, model?: string) =>
    request<ChapterPipelineResult>(`/projects/${projectId}/chapters/${chapterId}/run`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
}
