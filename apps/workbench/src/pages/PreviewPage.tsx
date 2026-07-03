import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { sceneService } from '@/services/scenes'
import { chapterService } from '@/services/chapters'
import { PlayerController } from '@novel2gal/runtime'
import type { RenderAction, TextDisplay } from '@novel2gal/runtime'
import type { VNScript } from '@novel2gal/core'
import { Play, Pause, SkipForward, SkipBack, Bug, ChevronRight, ImageIcon } from 'lucide-react'

function assetImageUrl(projectId: string, type: string, filePath: string): string {
  return `/api/projects/${projectId}/assets/image/${type}/${filePath}`
}

function actionToDisplay(action: RenderAction | null): TextDisplay | null {
  if (!action) return null
  switch (action.type) {
    case 'showNarration': return { mode: 'narration', text: action.text }
    case 'showDialogue': return { mode: 'dialogue', text: action.text, characterId: action.characterId, displayName: action.displayName }
    case 'showThought': return { mode: 'thought', text: action.text, characterId: action.characterId, displayName: action.displayName }
    default: return null
  }
}

export function PreviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => chapterService.list(projectId!),
    enabled: !!projectId,
  })

  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [debugMode, setDebugMode] = useState(false)
  const [script, setScript] = useState<VNScript | null>(null)
  const [currentAction, setCurrentAction] = useState<RenderAction | null>(null)
  const [textDisplay, setTextDisplay] = useState<TextDisplay | null>(null)
  const [bgId, setBgId] = useState<string>('default')
  const [bgLabel, setBgLabel] = useState<string>('')
  const [characters, setCharacters] = useState<Map<string, { expression?: string; position?: string }>>(new Map())
  const [stepIndex, setStepIndex] = useState(0)
  const [totalSteps, setTotalSteps] = useState(0)
  const [status, setStatus] = useState<string>('idle')
  const controllerRef = useRef<PlayerController | null>(null)
  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch scenes for selected chapter
  const { data: scenes } = useQuery({
    queryKey: ['scenes', selectedChapterId],
    queryFn: () => sceneService.listByChapter(projectId!, selectedChapterId!),
    enabled: !!projectId && !!selectedChapterId,
  })

  // Fetch script when scene selected
  const { data: scriptData } = useQuery({
    queryKey: ['script', projectId, selectedSceneId],
    queryFn: () => sceneService.getScript(projectId!, selectedSceneId!),
    enabled: !!projectId && !!selectedSceneId,
  })

  useEffect(() => {
    if (scriptData) {
      setScript(scriptData)
      const ctrl = new PlayerController(scriptData)
      controllerRef.current = ctrl
      const state = ctrl.getState()
      setTotalSteps(state.totalSteps)
      setStepIndex(0)
      setStatus(state.status)
      setCharacters(new Map())
      setBgId('default')
      setBgLabel('')
      setTextDisplay(null)
      setCurrentAction(null)
    }
  }, [scriptData])

  const clearAutoPlay = useCallback(() => {
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current)
      autoPlayTimerRef.current = null
    }
  }, [])

  const doAdvance = useCallback(() => {
    const ctrl = controllerRef.current
    if (!ctrl) return
    const { action, autoWait } = ctrl.advance()
    const state = ctrl.getState()

    setCurrentAction(action)
    setStepIndex(state.currentStepIndex)
    setStatus(state.status)

    if (action) {
      switch (action.type) {
        case 'setBackground':
          setBgId(action.id)
          setBgLabel(action.label ?? '')
          break
        case 'showCharacter':
          setCharacters(new Map(state.charactersOnScreen))
          break
        case 'hideCharacter':
          setCharacters(new Map(state.charactersOnScreen))
          break
        case 'showNarration':
        case 'showDialogue':
        case 'showThought':
          setTextDisplay(actionToDisplay(action))
          break
      }

      if (state.autoPlay && state.status === 'playing') {
        const delay = autoWait ? (action.type === 'wait' ? action.durationMs : 800) : state.autoPlayDelay
        autoPlayTimerRef.current = setTimeout(() => doAdvance(), delay)
      }
    }
  }, [])

  const handleNext = useCallback(() => {
    clearAutoPlay()
    doAdvance()
  }, [clearAutoPlay, doAdvance])

  const handleBack = useCallback(() => {
    clearAutoPlay()
    const ctrl = controllerRef.current
    if (!ctrl) return
    const action = ctrl.goBack()
    const state = ctrl.getState()
    setStepIndex(state.currentStepIndex)
    setStatus(state.status)
    setCurrentAction(action)
    setTextDisplay(action ? actionToDisplay(action) : null)
    setCharacters(new Map(state.charactersOnScreen))
    if (state.currentBackground) {
      setBgId(state.currentBackground.id)
      setBgLabel(state.currentBackground.label ?? '')
    }
  }, [clearAutoPlay])

  const handleToggleAutoPlay = useCallback(() => {
    const ctrl = controllerRef.current
    if (!ctrl) return
    const state = ctrl.getState()
    const newAutoPlay = !state.autoPlay
    ctrl.setAutoPlay(newAutoPlay)
    if (newAutoPlay) {
      doAdvance()
    } else {
      clearAutoPlay()
    }
  }, [clearAutoPlay, doAdvance])

  const handleAreaClick = useCallback(() => {
    if (status === 'playing') handleNext()
  }, [status, handleNext])

  // Cleanup auto-play on unmount
  useEffect(() => {
    return () => clearAutoPlay()
  }, [clearAutoPlay])

  const posToStyle = (pos?: string) => {
    switch (pos) {
      case 'left': return 'left-[15%]'
      case 'right': return 'left-[75%]'
      default: return 'left-[45%]'
    }
  }

  return (
    <div className="flex gap-4 h-full -m-6 p-0">
      {/* Left: Chapter/Scene navigation */}
      <aside className="w-52 border-r border-border overflow-auto shrink-0 p-4">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">章节/场景</h3>
        <div className="space-y-1">
          {chapters?.slice(0, 20).map((ch) => (
            <div key={ch.chapterId}>
              <button
                onClick={() => {
                  setSelectedChapterId(ch.chapterId)
                  setSelectedSceneId(null)
                  setScript(null)
                }}
                className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                  selectedChapterId === ch.chapterId
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {ch.title}
              </button>
              {selectedChapterId === ch.chapterId && scenes && (
                <div className="ml-3 space-y-0.5 mt-0.5">
                  {scenes.map((sc, i) => (
                    <button
                      key={sc.sceneId}
                      onClick={() => setSelectedSceneId(sc.sceneId)}
                      className={`w-full text-left px-2 py-1 rounded text-xs transition-colors flex items-center gap-1 ${
                        selectedSceneId === sc.sceneId
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <ChevronRight className="w-3 h-3" />
                      场景 {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* Center: VN playback area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div
          className="relative flex-1 bg-black/90 overflow-hidden cursor-pointer select-none"
          onClick={handleAreaClick}
          style={{ aspectRatio: '16/9', maxHeight: 'calc(100vh - 200px)' }}
        >
          {/* Background */}
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-slate-800 to-slate-900">
            {bgId !== 'default' ? (
              <img
                key={bgId}
                src={assetImageUrl(projectId!, 'bg', `${bgId}.png`)}
                alt={bgLabel}
                className="w-full h-full object-cover"
                onError={(e) => {
                  // Fallback to placeholder if image fails to load
                  (e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : null}
            {/* Fallback text overlay when no image */}
            <span className="absolute text-slate-500 text-sm pointer-events-none">
              {bgId === 'default' ? '选择场景开始预览' : `背景: ${bgLabel || bgId}`}
            </span>
          </div>

          {/* Characters */}
          {Array.from(characters.entries()).map(([id, char]) => (
            <div
              key={id}
              className={`absolute bottom-[25%] ${posToStyle(char.position)} transform -translate-x-1/2 transition-all duration-300`}
              style={{ width: '180px', height: '300px' }}
            >
              <img
                src={assetImageUrl(projectId!, 'char', `${id}/${char.expression ?? 'default'}.png`)}
                alt={id}
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none'
                }}
              />
              {/* Fallback placeholder */}
              <div className="absolute inset-0 flex items-center justify-center bg-slate-700/60 rounded-lg border border-slate-600 pointer-events-none" style={{ display: 'none' }}>
                <span className="text-xs text-slate-400 text-center p-2">
                  {id}
                  {char.expression && <span className="block text-[10px]">{char.expression}</span>}
                </span>
              </div>
            </div>
          ))}

          {/* Text box */}
          {textDisplay && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/80 backdrop-blur-sm border-t border-slate-700 p-4">
              {textDisplay.mode === 'dialogue' && textDisplay.displayName && (
                <div className="text-primary font-medium text-sm mb-1">{textDisplay.displayName}</div>
              )}
              {textDisplay.mode === 'thought' && textDisplay.displayName && (
                <div className="text-purple-400 font-medium text-sm mb-1 italic">{textDisplay.displayName} (内心)</div>
              )}
              <p className={`text-sm leading-relaxed ${
                textDisplay.mode === 'narration' ? 'text-slate-300 italic' :
                textDisplay.mode === 'thought' ? 'text-purple-300 italic' :
                'text-white'
              }`}>
                {textDisplay.text}
              </p>
            </div>
          )}

          {/* Status indicator */}
          {status === 'ended' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <p className="text-white text-lg">场景结束</p>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-2 py-3 border-t border-border bg-background">
          <button onClick={handleBack} className="p-2 rounded hover:bg-secondary" title="后退">
            <SkipBack className="w-4 h-4" />
          </button>
          <button onClick={handleNext} className="p-2 rounded hover:bg-secondary" title="下一步">
            <SkipForward className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggleAutoPlay}
            className={`p-2 rounded ${controllerRef.current?.getState().autoPlay ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}
            title="自动播放"
          >
            <Play className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground ml-2">
            {stepIndex} / {totalSteps}
          </span>
          <button
            onClick={() => setDebugMode(!debugMode)}
            className={`p-2 rounded ml-2 ${debugMode ? 'bg-yellow-500/20 text-yellow-500' : 'hover:bg-secondary'}`}
            title="调试模式"
          >
            <Bug className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Right: Info panel */}
      <aside className="w-56 border-l border-border p-4 shrink-0 overflow-auto">
        <h3 className="font-medium mb-3 text-sm text-muted-foreground">信息面板</h3>
        <div className="space-y-3 text-xs">
          <div>
            <span className="text-muted-foreground">状态:</span>
            <span className="ml-2">{status}</span>
          </div>
          <div>
            <span className="text-muted-foreground">步骤:</span>
            <span className="ml-2">{stepIndex} / {totalSteps}</span>
          </div>
          {selectedSceneId && (
            <div>
              <span className="text-muted-foreground">场景:</span>
              <span className="ml-2 break-all">{selectedSceneId}</span>
            </div>
          )}

          {debugMode && currentAction && (
            <div className="mt-4 p-2 bg-muted rounded text-xs">
              <p className="font-medium mb-1">Debug: 当前 Action</p>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(currentAction, null, 2)}</pre>
            </div>
          )}

          {debugMode && (
            <div className="mt-2 p-2 bg-muted rounded text-xs">
              <p className="font-medium mb-1">Debug: 角色状态</p>
              {Array.from(characters.entries()).map(([id, c]) => (
                <div key={id}>{id}: {c.expression ?? '-'} @ {c.position ?? 'center'}</div>
              ))}
              {characters.size === 0 && <p className="text-muted-foreground">无角色</p>}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
