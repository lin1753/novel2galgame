import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Upload, ChevronRight, ChevronLeft } from 'lucide-react'
import { useCreateProject } from '@/hooks/useProjects'
import { projectService } from '@/services/projects'
import type { ProjectConfig, FidelityMode, SegmentationMode, BudgetMode } from '@novel2gal/core'

type Step = 1 | 2 | 3

export function NewProjectPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(1)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [config, setConfig] = useState<Partial<ProjectConfig>>({
    fidelityMode: 'standard' as FidelityMode,
    segmentationMode: 'standard' as SegmentationMode,
    budgetMode: 'balanced' as BudgetMode,
    visualStyleTemplate: 'school-romance-anime',
  })
  const [projectId, setProjectId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const createProject = useCreateProject()

  const handleCreate = async () => {
    setIsCreating(true)
    try {
      const project = await createProject.mutateAsync({
        title: title || file?.name?.replace(/\.txt$/i, '') || '未命名项目',
        config,
      })
      setProjectId(project.projectId)
      setStep(3)
    } catch (err) {
      alert(`创建失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
    }
  }

  const handleImport = async () => {
    if (!file || !projectId) return
    setIsCreating(true)
    try {
      await projectService.import(projectId, file)
      navigate(`/projects/${projectId}/overview`)
    } catch (err) {
      alert(`导入失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">新建项目</h1>

      {/* Progress indicator */}
      <div className="flex items-center gap-2 mb-8">
        {([1, 2, 3] as Step[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step >= s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            }`}>{s}</div>
            <span className="text-sm">{s === 1 ? '导入文件' : s === 2 ? '项目信息' : '确认创建'}</span>
            {s < 3 && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {/* Step 1: Import File */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="border-2 border-dashed border-border rounded-lg p-10 text-center hover:border-primary/50 transition-colors">
            <Upload className="w-10 h-10 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground mb-4">选择 .txt 小说文件</p>
            <input
              type="file"
              accept=".txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block mx-auto"
            />
          </div>
          {file && (
            <div className="bg-secondary rounded p-3 text-sm">
              <p>文件: {file.name}</p>
              <p>大小: {(file.size / 1024).toFixed(1)} KB</p>
            </div>
          )}
          <div className="flex justify-end">
            <button
              onClick={() => { setTitle(file?.name?.replace(/\.txt$/i, '') ?? ''); setStep(2) }}
              disabled={!file}
              className="flex items-center gap-1 px-4 py-2 bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              下一步 <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Project Info & Params */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1">项目名称</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
              placeholder="默认使用文件名"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">保真度模式</label>
              <select
                value={config.fidelityMode}
                onChange={(e) => setConfig({ ...config, fidelityMode: e.target.value as FidelityMode })}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
              >
                <option value="conservative">保守</option>
                <option value="standard">标准</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">分镜策略</label>
              <select
                value={config.segmentationMode}
                onChange={(e) => setConfig({ ...config, segmentationMode: e.target.value as SegmentationMode })}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
              >
                <option value="conservative">保守</option>
                <option value="standard">标准</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">视觉风格</label>
              <select
                value={config.visualStyleTemplate}
                onChange={(e) => setConfig({ ...config, visualStyleTemplate: e.target.value })}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
              >
                <option value="school-romance-anime">校园恋爱</option>
                <option value="urban-romance">都市恋爱</option>
                <option value="fresh-japanese">日系清新</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">预算模式</label>
              <select
                value={config.budgetMode}
                onChange={(e) => setConfig({ ...config, budgetMode: e.target.value as BudgetMode })}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
              >
                <option value="high_quality">高质量</option>
                <option value="balanced">均衡</option>
                <option value="budget">省钱</option>
              </select>
            </div>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="flex items-center gap-1 px-4 py-2 border border-border rounded">
              <ChevronLeft className="w-4 h-4" /> 上一步
            </button>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="flex items-center gap-1 px-4 py-2 bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              {isCreating ? '创建中...' : '创建项目'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Import & Done */}
      {step === 3 && (
        <div className="space-y-4 text-center py-10">
          <p className="text-lg">项目已创建!</p>
          <p className="text-muted-foreground">点击下方按钮导入小说文件并开始</p>
          <button
            onClick={handleImport}
            disabled={isCreating}
            className="px-6 py-2 bg-primary text-primary-foreground rounded disabled:opacity-50"
          >
            {isCreating ? '导入中...' : '导入文件并进入项目'}
          </button>
        </div>
      )}
    </div>
  )
}
