import { useState } from 'react'
import { Plus, Trash2, GripVertical, Image, User, EyeOff, MessageCircle, Brain, Clock, Zap, ArrowRight } from 'lucide-react'
import type { VNStep } from '@novel2gal/core'

const stepIcons: Record<string, typeof Image> = {
  bg: Image, show: User, hide: EyeOff, narration: MessageCircle,
  say: MessageCircle, thought: Brain, pause: Clock, transition: Zap,
}

const stepColors: Record<string, string> = {
  bg: 'bg-blue-100 text-blue-600', show: 'bg-green-100 text-green-600',
  hide: 'bg-gray-100 text-gray-500', narration: 'bg-slate-100 text-slate-600',
  say: 'bg-amber-100 text-amber-600', thought: 'bg-purple-100 text-purple-600',
  pause: 'bg-orange-100 text-orange-600', transition: 'bg-cyan-100 text-cyan-600',
}

function getStepPreview(step: VNStep): string {
  switch (step.type) {
    case 'bg': return (step as any).backgroundLabel ?? (step as any).backgroundId ?? ''
    case 'show': return `${(step as any).characterId} ${(step as any).expression ?? ''}`.trim()
    case 'hide': return (step as any).characterId ?? ''
    case 'narration': case 'say': case 'thought':
      const text = (step as any).text ?? ''
      return text.length > 40 ? text.slice(0, 40) + '...' : text
    case 'pause': return `${(step as any).durationMs ?? 1000}ms`
    case 'transition': return (step as any).name ?? 'fade'
    default: return ''
  }
}

interface StepTimelineProps {
  steps: VNStep[]
  selectedIndex: number
  onSelect: (index: number) => void
  onAdd: (afterIndex: number) => void
  onDelete: (index: number) => void
  onMove: (from: number, to: number) => void
}

export function StepTimeline({ steps, selectedIndex, onSelect, onAdd, onDelete, onMove }: StepTimelineProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== index) {
      onMove(dragIndex, index)
    }
    setDragIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border bg-card flex items-center justify-between">
        <span className="text-xs font-medium text-deep-purple">步骤时间线</span>
        <button onClick={() => onAdd(selectedIndex)}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-sakura/10 text-sakura rounded-lg hover:bg-sakura/20 transition-colors">
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {steps.map((step, index) => {
          const Icon = stepIcons[step.type] ?? MessageCircle
          const colorClass = stepColors[step.type] ?? 'bg-gray-100 text-gray-500'
          const isSelected = index === selectedIndex
          const isDragOver = index === dragOverIndex

          return (
            <div
              key={step.stepId}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
              onClick={() => onSelect(index)}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all duration-150 group ${
                isSelected
                  ? 'bg-lavender/20 border border-lavender/30 shadow-sm'
                  : isDragOver
                  ? 'bg-sakura/10 border border-dashed border-sakura/30'
                  : 'hover:bg-muted border border-transparent'
              }`}
            >
              <GripVertical className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-50 cursor-grab shrink-0" />
              <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                <Icon className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[10px] font-medium text-muted-foreground uppercase">{step.type}</span>
                <p className="text-xs text-foreground truncate">{getStepPreview(step)}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(index) }}
                className="p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
