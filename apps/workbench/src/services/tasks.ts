import { request } from './api'
import type { TaskRecord } from '@novel2gal/core'

export const taskService = {
  list: (projectId: string) =>
    request<TaskRecord[]>(`/projects/${projectId}/tasks`),
}
