import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Upload, Sparkles } from 'lucide-react'
import { projectService } from '@/services/projects'

export function NewProjectPage() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!file) return
    setIsCreating(true)
    setError(null)
    try {
      // 1. Create project
      const project = await projectService.create({
        title: title || file.name.replace(/\.txt$/i, ''),
      })
      // 2. Import file
      await projectService.import(project.projectId, file)
      // 3. Navigate to overview
      navigate(`/projects/${project.projectId}/overview`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent flex items-center gap-2 mb-6">
        <Sparkles className="w-6 h-6 text-sakura" />
        新建项目
      </h1>

      <div className="space-y-6">
        {/* File Upload */}
        <div>
          <label className="block text-sm font-medium text-deep-purple mb-2">选择小说文件</label>
          <div className="border-2 border-dashed border-lavender/40 rounded-2xl p-10 text-center hover:border-lavender transition-colors bg-card shadow-card">
            <Upload className="w-10 h-10 mx-auto mb-3 text-lavender" />
            <p className="text-muted-foreground mb-3">选择 .txt 小说文件</p>
            <input
              type="file"
              accept=".txt"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setFile(f)
                if (f && !title) setTitle(f.name.replace(/\.txt$/i, ''))
              }}
              className="block mx-auto"
            />
          </div>
          {file && (
            <div className="mt-2 px-3 py-2 rounded-xl bg-sakura/5 border border-sakura/20 text-sm">
              <span className="text-deep-purple font-medium">{file.name}</span>
              <span className="text-muted-foreground ml-2">({(file.size / 1024).toFixed(0)} KB)</span>
            </div>
          )}
        </div>

        {/* Project Title */}
        <div>
          <label className="block text-sm font-medium text-deep-purple mb-2">项目名称</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="默认使用文件名"
            className="w-full px-4 py-2.5 bg-card border border-border rounded-xl focus:ring-2 focus:ring-ring focus:outline-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleCreate}
          disabled={!file || isCreating}
          className="w-full px-6 py-3 bg-gradient-to-r from-sakura to-lavender text-white rounded-xl font-medium disabled:opacity-50 transition-all hover:shadow-lg text-base"
        >
          {isCreating ? '创建中...' : '创建项目并导入'}
        </button>
      </div>
    </div>
  )
}
