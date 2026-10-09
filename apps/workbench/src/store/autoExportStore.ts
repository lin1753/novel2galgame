/**
 * Global progress store — persists SSE state across page navigation.
 * Singleton: tracks pipeline progress for both single chapter runs and auto-export.
 */


/** Backend SSE progress event (progress.ts ProgressEvent) — locally typed to avoid coupling. */
interface SSEProgressEvent {
  status: string
  stage: string
  chapterId?: string
  chapterIndex?: number
  sceneId?: string
  sceneIndex?: number
  sceneCount?: number
  message?: string
  attempt?: number
  data?: { taskId?: string; outputPath?: string; stagesRun?: number; stagesCached?: number; stagesDegraded?: number; tokens?: { prompt: number; completion: number } }
}

export interface ChapterProgress {
  chapterId: string
  chapterIndex: number
  stage: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retry_scheduled'
  message?: string
  /** 1-based attempt number from the backend (present on running/retry events) */
  attempt?: number
  /** Structured scene progress (S9) — present on scene_worker events. */
  sceneId?: string
  sceneIndex?: number
  sceneCount?: number
  /** Stage-cache stats (stage 3 Phase 4) — carried on complete events. */
  stagesRun?: number
  stagesCached?: number
  stagesDegraded?: number
  tokens?: { prompt: number; completion: number }
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
      const event = JSON.parse(e.data) as SSEProgressEvent
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
            message: event.stage === 'retry_scheduled' && event.attempt != null
              ? `第 ${event.attempt} 次尝试失败，${event.message ?? '等待重试…'}`
              : event.message,
            attempt: event.attempt ?? existing.attempt,
            sceneId: event.sceneId ?? existing.sceneId,
            sceneIndex: event.sceneIndex ?? existing.sceneIndex,
            sceneCount: event.sceneCount ?? existing.sceneCount,
            stagesRun: event.data?.stagesRun ?? existing.stagesRun,
            stagesCached: event.data?.stagesCached ?? existing.stagesCached,
            stagesDegraded: event.data?.stagesDegraded ?? existing.stagesDegraded,
            tokens: event.data?.tokens ?? existing.tokens,
          })
        }
        const logs = [...prev.logs, msg].slice(-200)

        // Derive running from explicit pipeline completion events
        const isComplete = event.stage === 'complete' || event.stage === 'cancelled'
        // If we receive a progress event, we know it's running (even if chapters map is empty on reload)
        const running = isComplete ? false : (prev.running || event.status === 'progress' || Array.from(chapters.values()).some(
          (c) => c.status === 'running' || c.status === 'queued' || c.status === 'retry_scheduled'
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
            const { results, pending, active, retryWaiting } = data.snapshot
            // Restore from snapshot
            pending.forEach((cid: string) => {
              if (!chapters.has(cid)) chapters.set(cid, { chapterId: cid, chapterIndex: 0, stage: 'queued', status: 'queued' })
            })
            Object.entries(results).forEach(([cid, status]) => {
              chapters.set(cid, {
                chapterId: cid,
                chapterIndex: 0,
                stage: 'done',
                status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'retry_scheduled' ? 'running' : 'cancelled'
              })
            })
            active.forEach((cid: string) => {
              chapters.set(cid, { chapterId: cid, chapterIndex: 0, stage: 'running', status: 'running' })
            })
            // Chapters inside their retry delay show as retrying, not stuck running
            ;(retryWaiting as string[] | undefined)?.forEach((cid: string) => {
              chapters.set(cid, { chapterId: cid, chapterIndex: 0, stage: 'retry_scheduled', status: 'running', message: '等待自动重试…' })
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
            const existing: ChapterProgress = chapters.get(chapterId) ?? {
              chapterId,
              chapterIndex: event.chapterIndex ?? 0,
              stage: event.stage,
              status: 'queued',
            }
            chapters.set(chapterId, {
              ...existing,
              stage: event.stage,
              status: (event.status === 'progress' ? 'running' : event.status) as ChapterProgress['status'],
              message: event.stage === 'retry_scheduled' && event.attempt != null
                ? `第 ${event.attempt} 次尝试失败，${event.message ?? '等待重试…'}`
                : event.message,
              attempt: event.attempt ?? existing.attempt,
              sceneId: event.sceneId ?? existing.sceneId,
              sceneIndex: event.sceneIndex ?? existing.sceneIndex,
              sceneCount: event.sceneCount ?? existing.sceneCount,
              stagesRun: event.data?.stagesRun ?? existing.stagesRun,
              stagesCached: event.data?.stagesCached ?? existing.stagesCached,
              stagesDegraded: event.data?.stagesDegraded ?? existing.stagesDegraded,
              tokens: event.data?.tokens ?? existing.tokens,
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
