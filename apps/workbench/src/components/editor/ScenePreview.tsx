import { useState, useEffect, useRef } from 'react'
import { PlayerController, type RenderAction, type PlayerState } from '@novel2gal/runtime'
import type { VNScript, VNStep } from '@novel2gal/core'

interface ScenePreviewProps {
  steps: VNStep[]
  currentIndex: number
}

export function ScenePreview({ steps, currentIndex }: ScenePreviewProps) {
  const controllerRef = useRef<PlayerController | null>(null)
  const [bgLabel, setBgLabel] = useState('')
  const [characters, setCharacters] = useState<Map<string, { expression?: string; position?: string }>>(new Map())
  const [textDisplay, setTextDisplay] = useState<{ mode: string; text: string; characterId?: string; displayName?: string } | null>(null)

  // Rebuild controller when steps change
  useEffect(() => {
    if (steps.length === 0) return
    const script: VNScript = {
      sceneId: 'editor_preview',
      chapterId: 'editor',
      steps,
      mappingMode: 'standard',
    }
    const ctrl = new PlayerController(script)
    controllerRef.current = ctrl

    // Jump to current index
    if (currentIndex > 0 && currentIndex < steps.length) {
      ctrl.goToStep(currentIndex)
    }
    updateDisplay(ctrl)
  }, [steps, currentIndex])

  const updateDisplay = (ctrl: PlayerController) => {
    const state = ctrl.getState()
    if (state.currentBackground) {
      setBgLabel(state.currentBackground.label ?? state.currentBackground.id)
    }
    setCharacters(new Map(state.charactersOnScreen))

    const action = ctrl.getCurrentRenderAction()
    if (action) {
      switch (action.type) {
        case 'showNarration':
          setTextDisplay({ mode: 'narration', text: action.text })
          break
        case 'showDialogue':
          setTextDisplay({ mode: 'dialogue', text: action.text, characterId: action.characterId, displayName: action.displayName })
          break
        case 'showThought':
          setTextDisplay({ mode: 'thought', text: action.text, characterId: action.characterId, displayName: action.displayName })
          break
        default:
          setTextDisplay(null)
      }
    }
  }

  const charEntries = Array.from(characters.entries())
  const positionMap: Record<string, string> = { left: '15%', center: '45%', right: '75%' }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border bg-card">
        <span className="text-xs font-medium text-deep-purple">场景预览</span>
        <span className="text-xs text-muted-foreground ml-2">步骤 {currentIndex + 1}/{steps.length}</span>
      </div>

      {/* VN Viewport */}
      <div className="flex-1 bg-gradient-to-b from-gray-900 to-gray-800 relative overflow-hidden">
        {/* Background */}
        {bgLabel && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-gray-400 text-sm opacity-60">{bgLabel}</span>
          </div>
        )}

        {/* Characters */}
        {charEntries.map(([id, char]) => (
          <div
            key={id}
            className="absolute bottom-24 transition-all duration-300"
            style={{ left: positionMap[char.position ?? 'center'] ?? '45%' }}
          >
            <div className="w-24 h-36 bg-gradient-to-b from-lavender/30 to-sakura/20 rounded-xl border border-lavender/30 flex flex-col items-center justify-center">
              <span className="text-[10px] text-deep-purple font-medium">{id}</span>
              {char.expression && (
                <span className="text-[9px] text-muted-foreground">{char.expression}</span>
              )}
            </div>
          </div>
        ))}

        {/* Text box */}
        {textDisplay && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/80 backdrop-blur-sm px-6 py-4">
            {textDisplay.displayName && (
              <div className="text-sm font-bold text-sakura mb-1">{textDisplay.displayName}</div>
            )}
            <p className={`text-sm leading-relaxed ${
              textDisplay.mode === 'narration' ? 'text-gray-300 italic' :
              textDisplay.mode === 'thought' ? 'text-purple-300 italic' :
              'text-white'
            }`}>
              {textDisplay.text}
            </p>
          </div>
        )}

        {!bgLabel && !textDisplay && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
            选择步骤查看预览
          </div>
        )}
      </div>
    </div>
  )
}
