import { request } from './api'

export interface ModelConfig {
  provider: string
  apiKey: string
  baseUrl?: string
  defaultModel: string
  imageModel?: string
  budgetMode: string
  timeout?: number
  retryCount?: number
}

export const configService = {
  getModels: () => request<ModelConfig>('/config/models'),

  updateModels: (config: ModelConfig) =>
    request<ModelConfig>('/config/models', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  testConnection: (config: Partial<ModelConfig>) =>
    request<{ success: boolean; message: string }>('/config/test-connection', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
}
