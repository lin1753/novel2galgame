import { request } from './api'
import type { SceneState, VNScript, FidelityReport, NarrativeParsingResult, AttributionResult, SegmentationResult, VisualPromptResult } from '@novel2gal/core'

export const sceneService = {
  listByChapter: (projectId: string, chapterId: string) =>
    request<SceneState[]>(`/projects/${projectId}/chapters/${chapterId}/scenes`),

  get: (projectId: string, sceneId: string) =>
    request<SceneState>(`/projects/${projectId}/scenes/${sceneId}`),

  getScript: (projectId: string, sceneId: string) =>
    request<VNScript>(`/projects/${projectId}/scenes/${sceneId}/script`),

  getFidelity: (projectId: string, sceneId: string) =>
    request<FidelityReport>(`/projects/${projectId}/scenes/${sceneId}/fidelity`),

  getNarrativeResult: (projectId: string, chapterId: string) =>
    request<NarrativeParsingResult>(`/projects/${projectId}/chapters/${chapterId}/narrative`),

  getAttributionResult: (projectId: string, chapterId: string) =>
    request<AttributionResult>(`/projects/${projectId}/chapters/${chapterId}/attribution`),

  getSegmentationResult: (projectId: string, chapterId: string) =>
    request<SegmentationResult>(`/projects/${projectId}/chapters/${chapterId}/segmentation`),

  getVisualPrompt: (projectId: string, sceneId: string) =>
    request<VisualPromptResult>(`/projects/${projectId}/scenes/${sceneId}/visual-prompt`),

  runVisualPrompt: (projectId: string, sceneId: string, body?: { styleTemplate?: string; model?: string }) =>
    request<VisualPromptResult>(`/projects/${projectId}/scenes/${sceneId}/visual-prompt/run`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  updateScript: (projectId: string, sceneId: string, script: VNScript) =>
    request<{ success: boolean; sceneId: string; stepCount: number }>(
      `/projects/${projectId}/scenes/${sceneId}/script`,
      { method: 'PUT', body: JSON.stringify(script) }
    ),
}
