/**
 * Global progress store — persists SSE state across page navigation.
 * Singleton: tracks pipeline progress for both single chapter runs and auto-export.
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

  /** SSE message handler — shared by watchProgress and start */
  private handleSSEMessage(e: MessageEvent) {
    try {
      const event = JSON.parse(e.data)
      if (event.status === 'connected') return

      const chapterId = event.chapterId as string | undefined
      const msg = chapterId
        ? `[${event.stage}] ${event.status}`
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
            status: (event.status === 'progress' ? 'running' : event.status) as ChapterProgress['status'],
            message: event.message,
          })
        }
        const logs = [...prev.logs, msg].slice(-200)
        
        // Derive running from explicit pipeline completion events
        const isComplete = event.stage === 'complete' || event.stage === 'cancelled'
        // If we receive a progress event, we know it's running (even if chapters map is empty on reload)
        const running = isComplete ? false : (prev.running || event.status === 'progress' || Array.from(chapters.values()).some(
          (c) => c.status === 'running' || c.status === 'queued'
        ))

        return { 
          chapters, 
          logs, 
          running,
          taskId: event.data?.taskId ?? prev.taskId,
          exportOutput: isComplete && event.status === 'completed'
            ? { success: true, outputPath: event.data?.outputPath }
            : isComplete && (event.status === 'failed' || event.status === 'cancelled')
              ? { success: false }
              : prev.exportOutput,
        }
      })
    } catch {}
  }

  /** Fetch the current backend execution state (to restore "running" and allow manual cancel after reload/disconnect) */
  async syncStatus(projectId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/auto-export/status`)
      if (!res.ok) return
      const data = await res.json()
      if (data.running) {
        this.update((prev) => {
          let chapters = new Map(prev.chapters)
          let logs = prev.logs.length === 0 ? ['Restored active task state'] : prev.logs
          if (data.snapshot) {
            const { results, pending, active } = data.snapshot
            // Restore from snapshot
            pending.forEach((cid: string) => {
              if (!chapters.has(cid)) chapters.set(cid, { chapterId: cid, chapterIndex: 0, stage: 'queued', status: 'queued' })
            })
            Object.entries(results).forEach(([cid, status]) => {
              chapters.set(cid, { 
                chapterId: cid,
                chapterIndex: 0,
                stage: 'done',
                status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'
              })
            })
            active.forEach((cid: string) => {
              chapters.set(cid, { chapterId: cid, chapterIndex: 0, stage: 'running', status: 'running' })
            })
          }
          return { running: true, taskId: data.taskId, logs, chapters }
        })
      }
    } catch {}
  }

  /** Connect SSE for a project — keeps existing state. Used by chapter pages for progress tracking. */
  watchProgress(projectId: string) {
    if (this.eventSource) {
      // If already watching the same project, skip
      const currentUrl = this.eventSource.url
      if (currentUrl.includes(projectId)) return
      this.eventSource.close()
    }
    this.update(() => ({ projectId }))

    const es = new EventSource(`/api/projects/${projectId}/progress`)
    this.eventSource = es

    es.onmessage = (e) => this.handleSSEMessage(e)

    es.onerror = () => {
      // SSE will auto-reconnect; don't clear state
    }
    
    // Sync status from backend to restore the "Cancel" button if a task is running
    this.syncStatus(projectId)
  }

  /** Start auto-export flow — resets state and connects SSE */
  start(projectId: string) {
    this.eventSource?.close()
    this.state = { running: true, projectId, chapters: new Map(), logs: ['Starting auto-export...'] }
    this.notify()

    const es = new EventSource(`/api/projects/${projectId}/progress`)
    this.eventSource = es

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        if (event.status === 'connected') return

        const chapterId = event.chapterId as string | undefined
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
              status: (event.status === 'progress' ? 'running' : event.status) as ChapterProgress['status'],
              message: event.message,
            })
          }
          const logs = [...prev.logs, msg].slice(-200)
          const isComplete = event.stage === 'complete' || event.stage === 'cancelled'
          return {
            chapters,
            logs,
            running: !isComplete,
            taskId: event.data?.taskId ?? prev.taskId,
            exportOutput: isComplete && event.status === 'completed'
              ? { success: true, outputPath: event.data?.outputPath }
              : isComplete && (event.status === 'failed' || event.status === 'cancelled')
                ? { success: false }
                : prev.exportOutput,
          }
        })
      } catch {}
    }

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors — only log if still running
      if (!this.state.running) return
      this.update((prev) => ({ logs: [...prev.logs, 'SSE connection lost, reconnecting...'].slice(-200) }))
    }
  }

  disconnect() {
    this.eventSource?.close()
    this.eventSource = null
  }

  /** Mark the run as failed (e.g. the POST /auto-export request itself failed) */
  fail(reason: string) {
    this.update((prev) => ({ running: false, logs: [...prev.logs, `Error: ${reason}`].slice(-200) }))
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
        return { chapters, logs: [...prev.logs, `Cancelled chapter ${chapterId}`].slice(-200) }
      })
    } catch {}
  }

  async cancelAll() {
    const projectId = this.state.projectId
    if (!projectId) return
    try {
      await fetch(`/api/projects/${projectId}/auto-export/cancel`, { method: 'POST' })
      this.update((prev) => {
        const chapters = new Map(prev.chapters)
        for (const [id, ch] of chapters) {
          if (ch.status === 'running' || ch.status === 'queued') {
            chapters.set(id, { ...ch, status: 'cancelled', stage: 'cancelled' })
          }
        }
        return {
          chapters,
          running: false,
          logs: [...prev.logs, 'All tasks cancelled by user'].slice(-200),
        }
      })
    } catch (err) {
      this.update((prev) => ({ logs: [...prev.logs, `Cancel request failed: ${err}`].slice(-200) }))
    }
  }
}

// Singleton
export const autoExportStore = new AutoExportStore()
