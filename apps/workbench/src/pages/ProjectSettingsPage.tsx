import { useState, useEffect } from 'react'
import { useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Loader2 } from 'lucide-react'
import type { ProjectConfig } from '@novel2gal/core'

const defaultConfig: ProjectConfig = {
  fidelityMode: 'standard',
  segmentationMode: 'standard',
  visualStyleTemplate: 'school-romance-anime',
  budgetMode: 'balanced',
  autoRunVisualPrompt: false,
  autoRunConsistencyReview: false,
  defaultTextModel: 'agnes-2.0-flash',
  language: 'zh-CN',
}

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const qc = useQueryClient()
  const [config, setConfig] = useState<ProjectConfig>(defaultConfig)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then(r => r.json()),
    enabled: !!projectId,
  })

  useEffect(() => {
    if (project?.config) setConfig(project.config)
  }, [project])

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch(`/api/projects/${projectId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      setMsg('配置已保存')
    } catch { setMsg('保存失败') }
    setSaving(false)
    setTimeout(() => setMsg(null), 3000)
  }

  const u = (patch: Partial<ProjectConfig>) => setConfig(prev => ({ ...prev, ...patch }))

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent">
          项目设置
        </h1>
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-sm font-medium hover:shadow-md disabled:opacity-50 transition-all">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>

      {/* Pipeline settings */}
      <Section title="管线参数">
        <RadioField label="忠实度模式" value={config.fidelityMode}
          options={[{ value: 'conservative', label: '保守 — 宁缺毋滥' }, { value: 'standard', label: '标准 — 平衡取舍' }]}
          onChange={(v) => u({ fidelityMode: v as any })} />
        <RadioField label="分镜模式" value={config.segmentationMode}
          options={[{ value: 'conservative', label: '保守 — 大场景' }, { value: 'standard', label: '标准 — 细粒度' }]}
          onChange={(v) => u({ segmentationMode: v as any })} />
        <RadioField label="预算模式" value={config.budgetMode}
          options={[{ value: 'high_quality', label: '高质量' }, { value: 'balanced', label: '均衡' }, { value: 'budget', label: '节省' }]}
          onChange={(v) => u({ budgetMode: v as any })} />
      </Section>

      {/* Model */}
      <Section title="模型">
        <Field label="默认文本模型">
          <input value={config.defaultTextModel}
            onChange={(e) => u({ defaultTextModel: e.target.value })}
            className="input" placeholder="agnes-2.0-flash" />
        </Field>
        <Field label="视觉风格模板">
          <input value={config.visualStyleTemplate}
            onChange={(e) => u({ visualStyleTemplate: e.target.value })}
            className="input" placeholder="school-romance-anime" />
        </Field>
      </Section>

      {/* Automation */}
      <Section title="自动化">
        <ToggleField label="自动生成视觉提示词" value={config.autoRunVisualPrompt}
          onChange={(v) => u({ autoRunVisualPrompt: v })} />
        <ToggleField label="自动运行一致性审查" value={config.autoRunConsistencyReview}
          onChange={(v) => u({ autoRunConsistencyReview: v })} />
      </Section>

      {/* Misc */}
      <Section title="其他">
        <Field label="语言">
          <select value={config.language} onChange={(e) => u({ language: e.target.value as 'zh-CN' })}
            className="input">
            <option value="zh-CN">简体中文</option>
          </select>
        </Field>
        <Field label="题材提示（可选）">
          <input value={config.genreHint ?? ''}
            onChange={(e) => u({ genreHint: e.target.value || undefined })}
            className="input" placeholder="如: 校园恋爱、古装仙侠" />
        </Field>
      </Section>

      {msg && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-xl text-sm shadow-lg z-50 ${
          msg.includes('失败') ? 'bg-destructive text-white' : 'bg-deep-purple text-white'
        }`}>
          {msg}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-2xl bg-card shadow-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border/60 bg-muted/20">
        <h3 className="font-medium text-sm text-deep-purple">{title}</h3>
      </div>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium mb-1 text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function RadioField({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium mb-2 text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        {options.map(o => (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              value === o.value
                ? 'border-deep-purple bg-deep-purple/10 text-deep-purple font-medium'
                : 'border-border hover:bg-muted text-muted-foreground'
            }`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <button onClick={() => onChange(!value)}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          value ? 'bg-deep-purple' : 'bg-border'
        }`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          value ? 'left-4' : 'left-0.5'
        }`} />
      </button>
    </div>
  )
}
