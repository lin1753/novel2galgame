import { useEffect, useState } from 'react'
import { projectService } from '@/services/projects'
import { autoExportStore, type AutoExportState, type ChapterProgress } from '@/store/autoExportStore'

/**
 * Hook that subscribes to the global auto-export store.
 * The store persists across page navigation so progress never resets.
 */
export function useAutoExport(projectId: string) {
  const [state, setState] = useState<AutoExportState>(autoExportStore.getState())

  useEffect(() => {
    // Subscribe to global store for state updates
    const unsub = autoExportStore.subscribe((s) => setState(s))
    return unsub
  }, [])

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
      autoExportStore.getState().logs.push(`Error: ${err instanceof Error ? err.message : err}`)
      autoExportStore.subscribe
      setState({ ...autoExportStore.getState() })
    }
  }

  const chapterList = Array.from(state.chapters.values()).sort((a, b) => a.chapterIndex - b.chapterIndex)
  const stats = {
    total: chapterList.length,
    completed: chapterList.filter((c) => c.status === 'completed').length,
    failed: chapterList.filter((c) => c.status === 'failed').length,
    running: chapterList.filter((c) => c.status === 'running').length,
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
