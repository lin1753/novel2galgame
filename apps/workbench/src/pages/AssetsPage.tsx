import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { assetService } from '@/services/assets'
import { Image, RefreshCw, Loader2, Pencil, Check, X, ExternalLink, Maximize2 } from 'lucide-react'

export function AssetsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<'bg' | 'character'>('bg')
  const [generating, setGenerating] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)

  const { data: assets, isLoading } = useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => assetService.list(projectId!),
    enabled: !!projectId,
  })

  const genMutation = useMutation({
    mutationFn: (body: { type: string; assetId: string; expression?: string; label?: string; prompt?: string }) =>
      assetService.generate(projectId!, body),
    onSuccess: (data) => { console.log('[AssetGen] Success:', data); qc.invalidateQueries({ queryKey: ['assets', projectId] }); setGenerating(null) },
    onError: (err) => { console.error('[AssetGen] Error:', err); setGenerating(null) },
  })

  const promptMutation = useMutation({
    mutationFn: (body: { type: string; assetId: string; expression?: string; prompt: string | null }) =>
      assetService.updatePrompt(projectId!, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets', projectId] }),
  })

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">加载中...</div>

  const bgCount = assets?.backgrounds.length ?? 0
  const charCount = assets?.characters.reduce((s, c) => s + c.expressions.length, 0) ?? 0

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Image className="w-5 h-5 text-sakura" />
        <h2 className="text-xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent">
          资产管理
        </h2>
        <span className="text-xs text-muted-foreground ml-auto">共 {bgCount + charCount} 个资源</span>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(['bg', 'character'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${activeTab === tab ? 'border-lavender text-deep-purple font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {tab === 'bg' ? `背景 (${bgCount})` : `角色立绘 (${charCount})`}
          </button>
        ))}
      </div>

      {activeTab === 'bg' && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {assets?.backgrounds.map(bg => {
            const scenes = assets?.sceneUsage?.backgrounds?.[bg.id] ?? []
            return (
              <div key={bg.id}>
                <AssetCard label={bg.label} status={bg.status} prompt={bg.prompt}
                  imageUrl={assetService.imageUrl(projectId!, 'bg', bg.file)}
                  isGenerating={generating === bg.id}
                  onGenerate={() => { setGenerating(bg.id); genMutation.mutate({ type: 'bg', assetId: bg.id, label: bg.label }) }}
                  onUpdatePrompt={(p) => promptMutation.mutate({ type: 'bg', assetId: bg.id, prompt: p })}
                  onEnlarge={() => setLightbox({ url: assetService.imageUrl(projectId!, 'bg', bg.file), label: bg.label })}
                />
                {scenes.length > 0 && (
                  <div className="mt-1 px-1">
                    {scenes.map((sid: string) => (
                      <button key={sid} onClick={() => navigate(`/projects/${projectId}/editor/${sid}`)}
                        className="text-[10px] text-muted-foreground hover:text-deep-purple transition-colors flex items-center gap-0.5">
                        <ExternalLink className="w-2.5 h-2.5" /> {sid.split('_').pop()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {bgCount === 0 && <p className="col-span-full text-center py-10 text-muted-foreground">运行章节管线后自动发现背景资源</p>}
        </div>
      )}

      {activeTab === 'character' && (
        <div className="space-y-6">
          {assets?.characters.map(char => {
            const scenes = assets?.sceneUsage?.characters?.[char.id] ?? []
            return (
            <div key={char.id} className="border border-border rounded-2xl p-4 bg-card shadow-card">
              <div className="flex items-center gap-2 mb-3">
                <h3 className="font-semibold text-deep-purple">{char.name || char.id}</h3>
                {scenes.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {scenes.length} 个场景
                  </span>
                )}
              </div>
              {scenes.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {scenes.map((sid: string) => (
                    <button key={sid} onClick={() => navigate(`/projects/${projectId}/editor/${sid}`)}
                      className="px-1.5 py-0.5 text-[10px] border border-border rounded hover:bg-muted hover:text-deep-purple transition-colors">
                      {sid.split('_').pop()}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {char.expressions.map(expr => (
                  <AssetCard key={expr.expression} label={expr.expression} status={expr.status} prompt={expr.prompt}
                    size="sm"
                    imageUrl={assetService.imageUrl(projectId!, 'char', expr.file)}
                    isGenerating={generating === `${char.id}/${expr.expression}`}
                    onGenerate={() => {
                      const key = `${char.id}/${expr.expression}`
                      setGenerating(key)
                      genMutation.mutate({ type: 'character', assetId: char.id, expression: expr.expression, label: `${char.name} ${expr.expression}` })
                    }}
                    onUpdatePrompt={(p) => promptMutation.mutate({ type: 'character', assetId: char.id, expression: expr.expression, prompt: p })}
                    onEnlarge={() => setLightbox({ url: assetService.imageUrl(projectId!, 'char', expr.file), label: `${char.name} ${expr.expression}` })}
                  />
                ))}
              </div>
            </div>
          )})}
          {charCount === 0 && <p className="text-center py-10 text-muted-foreground">运行章节管线后自动发现角色资源</p>}
        </div>
      )}

      {/* Lightbox modal */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightbox(null)}>
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img src={lightbox.url} alt={lightbox.label}
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl" />
            <p className="absolute bottom-2 left-2 text-white text-sm bg-black/50 px-2 py-1 rounded">{lightbox.label}</p>
            <button onClick={() => setLightbox(null)}
              className="absolute top-2 right-2 text-white bg-black/50 rounded-full p-1 hover:bg-black/70">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AssetCard({ label, status, prompt, imageUrl, isGenerating, onGenerate, onUpdatePrompt, onEnlarge, size = 'md' }: {
  label: string; status: string; prompt: string | null; imageUrl: string
  isGenerating: boolean; onGenerate: () => void; onUpdatePrompt: (p: string | null) => void
  onEnlarge?: () => void
  size?: 'sm' | 'md'
}) {
  const [imgError, setImgError] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptValue, setPromptValue] = useState(prompt ?? '')

  const savePrompt = () => {
    onUpdatePrompt(promptValue || null)
    setEditingPrompt(false)
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card shadow-card transition-all hover:shadow-md">
      <div className={`relative ${size === 'sm' ? 'h-28' : 'h-36'} bg-gradient-to-b from-slate-800 to-slate-900 flex items-center justify-center overflow-hidden group`}
        onClick={() => { if (status === 'generated' && !imgError) onEnlarge?.() }}>
        {status === 'generated' && !imgError ? (
          <>
            <img src={imageUrl} alt={label} className="w-full h-full object-cover" onError={() => setImgError(true)} />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <Maximize2 className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </>
        ) : (
          <div className="text-center p-2">
            <Image className={`mx-auto ${size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'} text-slate-600`} />
            <span className="block text-xs text-slate-500 mt-1 truncate max-w-[120px]">{label}</span>
          </div>
        )}
        <span className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
          status === 'generated' ? 'bg-emerald-500/80 text-white' : status === 'missing' ? 'bg-red-500/80 text-white' : 'bg-slate-500/80 text-white'
        }`}>{status === 'generated' ? '已生成' : status === 'missing' ? '未生成' : '占位'}</span>
      </div>
      <div className="p-2 space-y-1">
        <p className="text-xs font-medium truncate text-foreground">{label}</p>

        {/* Prompt display/edit */}
        {editingPrompt ? (
          <div className="flex gap-1">
            <input value={promptValue} onChange={e => setPromptValue(e.target.value)} placeholder="输入生成提示词..."
              className="flex-1 px-1.5 py-0.5 text-[10px] border border-border rounded bg-background" autoFocus />
            <button onClick={savePrompt} className="p-0.5 text-green-500"><Check className="w-3 h-3" /></button>
            <button onClick={() => setEditingPrompt(false)} className="p-0.5 text-muted-foreground"><X className="w-3 h-3" /></button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {prompt && <p className="text-[10px] text-muted-foreground truncate flex-1">{prompt}</p>}
            <button onClick={() => { setPromptValue(prompt ?? ''); setEditingPrompt(true) }}
              className="p-0.5 text-muted-foreground hover:text-foreground"><Pencil className="w-2.5 h-2.5" /></button>
          </div>
        )}

        <button onClick={onGenerate} disabled={isGenerating}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 bg-lavender/10 text-deep-purple rounded-lg text-[10px] font-medium hover:bg-lavender/20 disabled:opacity-50 transition-colors">
          {isGenerating ? <><Loader2 className="w-3 h-3 animate-spin" /> 生成中...</> : <><RefreshCw className="w-3 h-3" /> {status === 'generated' ? '重新生成' : '生成'}</>}
        </button>
      </div>
    </div>
  )
}
