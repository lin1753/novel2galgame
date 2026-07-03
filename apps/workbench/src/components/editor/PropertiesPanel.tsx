import type { VNStep } from '@novel2gal/core'

interface PropertiesPanelProps {
  step: VNStep | undefined
  stepIndex: number
  onUpdate: (updates: Partial<VNStep>) => void
}

export function PropertiesPanel({ step, stepIndex, onUpdate }: PropertiesPanelProps) {
  if (!step) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-3 py-2 border-b border-border bg-card">
          <span className="text-xs font-medium text-deep-purple">属性面板</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          选择一个步骤
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border bg-card">
        <span className="text-xs font-medium text-deep-purple">属性面板</span>
        <span className="text-xs text-muted-foreground ml-2">#{stepIndex + 1} {step.type}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Common: step type */}
        <Field label="类型">
          <select
            value={step.type}
            onChange={(e) => onUpdate({ type: e.target.value as any })}
            className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none"
          >
            <option value="bg">背景 (bg)</option>
            <option value="show">显示角色 (show)</option>
            <option value="hide">隐藏角色 (hide)</option>
            <option value="narration">旁白 (narration)</option>
            <option value="say">对话 (say)</option>
            <option value="thought">内心独白 (thought)</option>
            <option value="pause">暂停 (pause)</option>
            <option value="transition">转场 (transition)</option>
          </select>
        </Field>

        {/* Type-specific fields */}
        {step.type === 'bg' && (
          <>
            <Field label="背景 ID">
              <input value={(step as any).backgroundId ?? ''} onChange={(e) => onUpdate({ backgroundId: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
            <Field label="背景名称">
              <input value={(step as any).backgroundLabel ?? ''} onChange={(e) => onUpdate({ backgroundLabel: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
          </>
        )}

        {step.type === 'show' && (
          <>
            <Field label="角色 ID">
              <input value={(step as any).characterId ?? ''} onChange={(e) => onUpdate({ characterId: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
            <Field label="表情">
              <input value={(step as any).expression ?? ''} onChange={(e) => onUpdate({ expression: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
            <Field label="位置">
              <select value={(step as any).position ?? 'center'} onChange={(e) => onUpdate({ position: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none">
                <option value="left">左</option>
                <option value="center">中</option>
                <option value="right">右</option>
              </select>
            </Field>
          </>
        )}

        {step.type === 'hide' && (
          <Field label="角色 ID">
            <input value={(step as any).characterId ?? ''} onChange={(e) => onUpdate({ characterId: e.target.value } as any)}
              className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
          </Field>
        )}

        {(step.type === 'say' || step.type === 'thought') && (
          <>
            <Field label="角色 ID">
              <input value={(step as any).characterId ?? ''} onChange={(e) => onUpdate({ characterId: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
            <Field label="显示名">
              <input value={(step as any).displayName ?? ''} onChange={(e) => onUpdate({ displayName: e.target.value } as any)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
            </Field>
          </>
        )}

        {(step.type === 'say' || step.type === 'thought' || step.type === 'narration') && (
          <Field label="文本">
            <textarea
              value={(step as any).text ?? ''}
              onChange={(e) => onUpdate({ text: e.target.value } as any)}
              rows={4}
              className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none resize-none"
            />
          </Field>
        )}

        {step.type === 'pause' && (
          <Field label="时长 (ms)">
            <input type="number" value={(step as any).durationMs ?? 1000}
              onChange={(e) => onUpdate({ durationMs: Number(e.target.value) } as any)}
              className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none" />
          </Field>
        )}

        {step.type === 'transition' && (
          <Field label="转场效果">
            <select value={(step as any).name ?? 'fade'} onChange={(e) => onUpdate({ name: e.target.value } as any)}
              className="w-full px-2.5 py-1.5 text-sm border border-border rounded-lg bg-input focus:ring-2 focus:ring-ring focus:outline-none">
              <option value="fade">淡入淡出 (fade)</option>
              <option value="cut">切换 (cut)</option>
              <option value="dissolve">溶解 (dissolve)</option>
            </select>
          </Field>
        )}

        {/* Read-only: stepId and order */}
        <div className="pt-2 border-t border-border space-y-1">
          <p className="text-[10px] text-muted-foreground">ID: {step.stepId}</p>
          <p className="text-[10px] text-muted-foreground">顺序: {(step as any).order}</p>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  )
}
