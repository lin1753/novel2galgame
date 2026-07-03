/**
 * Auto-export progress store — persists SSE state across page navigation.
 * Uses a module-level singleton so the EventSource stays alive while the app is open.
 */

export interface ChapterProgress {
  chapterId: string
  chapterIndex: number
  stage: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  message?: string
}

export interface AutoExportState {
  running: boolean
  taskId?: string
  projectId?: string
  chapters: Map<string, ChapterProgress>
  logs: string[]
  exportOutput?: { success: boolean; outputPath?: string }
}

type Listener = (state: AutoExportState) => void

class AutoExportStore {
  private state: AutoExportState = {
    running: false,
    chapters: new Map(),
    logs: [],
  }
  private listeners = new Set<Listener>()
  private eventSource: EventSource | null = null

  getState(): AutoExportState {
    return this.state
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn({ ...this.state, chapters: new Map(this.state.chapters) })
  }

  private update(fn: (prev: AutoExportState) => Partial<AutoExportState>) {
    const patch = fn(this.state)
    if (patch.chapters) this.state.chapters = patch.chapters as Map<string, ChapterProgress>
    if (patch.logs) this.state.logs = patch.logs
    Object.assign(this.state, { ...patch, chapters: this.state.chapters, logs: this.state.logs })
    this.notify()
  }

  start(projectId: string) {
    // Close existing SSE
    this.eventSource?.close()

    // Reset state for new project
    this.state = {
      running: false,
      chapters: new Map(),
      logs: [],
    }

    this.update(() => ({
      running: true,
      projectId,
      chapters: new Map(),
      logs: ['Starting auto-export...'],
      exportOutput: undefined,
    }))

    const es = new EventSource(`/api/projects/${projectId}/progress`)
    this.eventSource = es

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        if (event.status === 'connected') return

        const chapterId = event.chapterId
        const msg = chapterId
          ? `[Ch${event.chapterIndex != null ? event.chapterIndex + 1 : ''}:${event.stage}] ${event.status}`
          : `[${event.stage}] ${event.status}${event.message ? ': ' + event.message : ''}`

        this.update((prev) => {
          const chapters = new Map(prev.chapters)
          if (chapterId) {
            const existing = chapters.get(chapterId) ?? {
              chapterId,
              chapterIndex: event.chapterIndex ?? 0,
              stage: event.stage,
              status: 'queued' as const,
            }
            chapters.set(chapterId, {
              ...existing,
              stage: event.stage,
              status: event.status as ChapterProgress['status'],
              message: event.message,
            })
          }
          const logs = [...prev.logs, msg].slice(-200)
          const isComplete = event.stage === 'complete'
          return {
            chapters,
            logs,
            running: !isComplete,
            taskId: event.data?.taskId ?? prev.taskId,
            exportOutput: isComplete && event.status === 'completed'
              ? { success: true, outputPath: event.data?.outputPath }
              : isComplete && event.status === 'failed'
                ? { success: false }
                : prev.exportOutput,
          }
        })
      } catch {}
    }

    es.onerror = () => {
      this.update(() => ({ running: false }))
      es.close()
      this.eventSource = null
    }
  }

  async cancelChapter(chapterId: string) {
    const projectId = this.state.projectId
    if (!projectId) return
    try {
      await fetch(`/api/projects/${projectId}/auto-export/cancel/${chapterId}`, { method: 'POST' })
      this.update((prev) => {
        const chapters = new Map(prev.chapters)
        chapters.set(chapterId, {
          ...chapters.get(chapterId) ?? { chapterId, chapterIndex: 0, stage: 'cancelled', status: 'cancelled' },
          status: 'cancelled',
          stage: 'cancelled',
        })
        return { chapters, logs: [...prev.logs, `Cancelled chapter ${chapterId}`] }
      })
    } catch {}
  }

  async cancelAll() {
    const projectId = this.state.projectId
    if (!projectId) return
    try {
      await fetch(`/api/projects/${projectId}/auto-export/cancel`, { method: 'POST' })
      this.update(() => ({ running: false, logs: [...this.state.logs, 'All cancelled'] }))
    } catch {}
  }
}

// Singleton
export const autoExportStore = new AutoExportStore()
