import { request } from './api'

export interface AssetBgEntry {
  id: string
  label: string
  file: string
  status: string
  prompt: string | null
}

export interface AssetExprEntry {
  expression: string
  file: string
  status: string
  prompt: string | null
}

export interface AssetCharEntry {
  id: string
  name: string
  expressions: AssetExprEntry[]
}

export interface AssetListResult {
  backgrounds: AssetBgEntry[]
  characters: AssetCharEntry[]
  sceneUsage?: {
    backgrounds: Record<string, string[]>
    characters: Record<string, string[]>
  }
  manifest: any | null
}

export const assetService = {
  list: (projectId: string) =>
    request<AssetListResult>(`/projects/${projectId}/assets`),

  generate: (projectId: string, body: { type: string; assetId: string; expression?: string; label?: string; prompt?: string }) =>
    request<{ success: boolean; file: string }>(`/projects/${projectId}/assets/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updatePrompt: (projectId: string, body: { type: string; assetId: string; expression?: string; prompt: string | null }) =>
    request<{ success: boolean }>(`/projects/${projectId}/assets/prompt`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  imageUrl: (projectId: string, type: string, filePath: string) =>
    `/api/projects/${projectId}/assets/image/${type}/${filePath}`,
}
