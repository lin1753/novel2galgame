import { create } from 'zustand'
import type { ProjectState, ChapterState, SceneState, TaskRecord } from '@novel2gal/core'

interface AppState {
  projects: ProjectState[]
  currentProjectId: string | null
  chaptersByProject: Record<string, ChapterState[]>
  scenesByChapter: Record<string, SceneState[]>
  tasksByProject: Record<string, TaskRecord[]>

  setProjects: (projects: ProjectState[]) => void
  setCurrentProject: (id: string | null) => void
  setChapters: (projectId: string, chapters: ChapterState[]) => void
  setScenes: (chapterId: string, scenes: SceneState[]) => void
  setTasks: (projectId: string, tasks: TaskRecord[]) => void
  updateProject: (projectId: string, updates: Partial<ProjectState>) => void
  updateChapter: (chapterId: string, updates: Partial<ChapterState>) => void
  updateScene: (sceneId: string, updates: Partial<SceneState>) => void
}

export const useAppStore = create<AppState>((set) => ({
  projects: [],
  currentProjectId: null,
  chaptersByProject: {},
  scenesByChapter: {},
  tasksByProject: {},

  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setChapters: (projectId, chapters) =>
    set((s) => ({ chaptersByProject: { ...s.chaptersByProject, [projectId]: chapters } })),
  setScenes: (chapterId, scenes) =>
    set((s) => ({ scenesByChapter: { ...s.scenesByChapter, [chapterId]: scenes } })),
  setTasks: (projectId, tasks) =>
    set((s) => ({ tasksByProject: { ...s.tasksByProject, [projectId]: tasks } })),
  updateProject: (projectId, updates) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.projectId === projectId ? { ...p, ...updates } : p)),
    })),
  updateChapter: (chapterId, updates) =>
    set((s) => {
      const next = { ...s.chaptersByProject }
      for (const pid of Object.keys(next)) {
        const idx = next[pid].findIndex((c) => c.chapterId === chapterId)
        if (idx >= 0) {
          next[pid] = [...next[pid]]
          next[pid][idx] = { ...next[pid][idx], ...updates }
          break
        }
      }
      return { chaptersByProject: next }
    }),
  updateScene: (sceneId, updates) =>
    set((s) => {
      const next = { ...s.scenesByChapter }
      for (const cid of Object.keys(next)) {
        const idx = next[cid].findIndex((sc) => sc.sceneId === sceneId)
        if (idx >= 0) {
          next[cid] = [...next[cid]]
          next[cid][idx] = { ...next[cid][idx], ...updates }
          break
        }
      }
      return { scenesByChapter: next }
    }),
}))
