import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { projectService } from '@/services/projects'
import { autoExportStore, type AutoExportState, type ChapterProgress } from '@/store/autoExportStore'

/**
 * Hook that subscribes to the global auto-export store.
 * The store persists across page navigation so progress never resets.
 */
export function useAutoExport(projectId: string) {
  const [state, setState] = useState<AutoExportState>(autoExportStore.getState())
  const qc = useQueryClient()
  const prevActiveRef = useRef(0)

  useEffect(() => {
    // Subscribe to global store for state updates
    const unsub = autoExportStore.subscribe((s) => setState(s))
    return unsub
  }, [])

  // Pipelines are async — refresh chapter/project queries when a run finishes
  // (active chapters drop to zero after terminal events), so status badges and
  // the running-state-dependent polling don't stick on stale data
  useEffect(() => {
    const unsub = autoExportStore.subscribe((s) => {
      const list = Array.from(s.chapters.values())
      const active = list.filter((c) => c.status === 'running' || c.status === 'queued' || c.status === 'retry_scheduled').length
      const terminal = list.filter((c) => ['completed', 'failed', 'cancelled'].includes(c.status)).length
      if (prevActiveRef.current > 0 && active === 0 && terminal > 0) {
        const pid = s.projectId || projectId
        qc.invalidateQueries({ queryKey: ['chapters', pid] })
        qc.invalidateQueries({ queryKey: ['project', pid] })
      }
      prevActiveRef.current = active
    })
    return unsub
  }, [qc, projectId])

  // Auto-connect SSE for real-time progress tracking (persists across navigation)
  useEffect(() => {
    if (projectId) {
      autoExportStore.watchProgress(projectId)
    }
    return () => {
      // Don't disconnect on unmount — SSE should stay alive across navigation
    }
  }, [projectId])

  const startAutoExport = async (opts?: { model?: string; maxChapters?: number; generateAssets?: boolean }) => {
    autoExportStore.start(projectId)
    try {
      await projectService.autoExport(projectId, opts ?? {})
    } catch (err) {
      // Reset running + notify subscribers — otherwise the button stays
      // disabled with "处理中..." forever after a 503/failed POST
      autoExportStore.fail(err instanceof Error ? err.message : String(err))
    }
  }

  const chapterList = Array.from(state.chapters.values()).sort((a, b) => a.chapterIndex - b.chapterIndex)
  const stats = {
    total: chapterList.length,
    completed: chapterList.filter((c) => c.status === 'completed').length,
    failed: chapterList.filter((c) => c.status === 'failed').length,
    running: chapterList.filter((c) => c.status === 'running' || c.status === 'retry_scheduled').length,
    queued: chapterList.filter((c) => c.status === 'queued').length,
    cancelled: chapterList.filter((c) => c.status === 'cancelled').length,
  }

  return {
    ...state,
    chapterList,
    stats,
    startAutoExport,
    cancelChapter: autoExportStore.cancelChapter.bind(autoExportStore),
    cancelAll: autoExportStore.cancelAll.bind(autoExportStore),
  }
}
