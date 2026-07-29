import { useState, useEffect } from 'react'
import { Wifi, Plus, Trash2, CheckCircle2, Loader2, AlertCircle, ChevronDown, ChevronRight, Zap } from 'lucide-react'

// ── Types ──────────────────────────────────────────────

interface Profile {
  name: string
  type: 'cloud' | 'local'
  baseUrl: string
  apiKey: string
  defaultModel: string
  imageModel?: string
  videoModel?: string
  enabled: boolean
}

interface ProfilesConfig {
  profiles: Profile[]
  activeProfile: string
}

interface ModelAssignment {
  profile: string
  model: string
}

interface ModelAssignments {
  text: ModelAssignment
  image: ModelAssignment
  video: ModelAssignment
}

type ModelType = 'text' | 'image' | 'video'

// ── Provider presets ───────────────────────────────────

const PROVIDER_PRESETS: Record<string, Partial<Profile>> = {
  'agnes-cloud': { baseUrl: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash', imageModel: 'agnes-image-2.1-flash', videoModel: 'agnes-video-v2.0', type: 'cloud' },
  'openai': { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', imageModel: 'gpt-image-2', type: 'cloud' },
  'deepseek': { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', type: 'cloud' },
  'moonshot': { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', type: 'cloud' },
  'zhipu': { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', imageModel: 'cogview-4-250304', type: 'cloud' },
  'local': { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen3-8b', type: 'local' },
}

const MODEL_PRESETS: Record<ModelType, Record<string, string[]>> = {
  text: {
    'agnes-cloud': ['agnes-2.0-flash'],
    'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    'deepseek': ['deepseek-chat', 'deepseek-reasoner'],
    'moonshot': ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    'zhipu': ['glm-4-flash', 'glm-4-plus'],
    'local': ['qwen3-8b', 'llama3', 'mistral'],
  },
  image: {
    'agnes-cloud': ['agnes-image-2.1-flash'],
    'openai': ['gpt-image-2', 'gpt-image-1'],
    'zhipu': ['cogview-4-250304', 'cogview-4', 'cogview-3-flash'],
    'siliconflow': ['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-3-5-large'],
  },
  video: {
    'agnes-cloud': ['agnes-video-v2.0'],
  },
}

const MODEL_TYPE_META: Record<ModelType, { icon: string; label: string; desc: string }> = {
  text: { icon: '📝', label: 'LLM 文本推理', desc: '叙事解析、角色归因、场景分割等管线 Agent' },
  image: { icon: '🎨', label: '图片生成', desc: '背景图、角色立绘' },
  video: { icon: '🎬', label: '视频生成', desc: '文生视频、图生视频、关键帧动画' },
}

// ── Helpers ─────────────────────────────────────────────

function getPresets(type: ModelType, profileName: string): string[] {
  // Map profile name to preset key
  const key = Object.keys(MODEL_PRESETS[type]).find(k => profileName.includes(k.replace('-cloud', ''))) ?? ''
  return MODEL_PRESETS[type][key] ?? []
}

function profileSupportsType(profile: Profile, type: ModelType): boolean {
  if (profile.type === 'local') return type === 'text' // local only supports text
  if (type === 'video') return profile.name.includes('agnes') // only agnes has video
  if (type === 'image') return ['agnes', 'openai', 'zhipu', 'siliconflow'].some(n => profile.name.includes(n))
  return true
}

// ── API ─────────────────────────────────────────────────

const api = {
  getProfiles: () => fetch('/api/config/profiles').then(r => r.json()) as Promise<ProfilesConfig>,
  getAssignments: () => fetch('/api/config/model-assignments').then(r => r.json()) as Promise<ModelAssignments>,
  saveAssignments: (a: ModelAssignments) =>
    fetch('/api/config/model-assignments', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }),
  saveProfile: (p: Profile) =>
    fetch('/api/config/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  activateProfile: (name: string) =>
    fetch(`/api/config/profiles/${name}/activate`, { method: 'POST' }),
  deleteProfile: (name: string) =>
    fetch(`/api/config/profiles/${name}`, { method: 'DELETE' }),
  testLLM: (model: string) =>
    fetch('/api/config/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: model }) }).then(r => r.json()) as Promise<{ success: boolean; message: string }>,
  testImage: (profile: string, model: string) =>
    fetch('/api/config/test-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, model }) }).then(r => r.json()) as Promise<{ success: boolean; message: string }>,
  testVideo: (profile: string, model: string) =>
    fetch('/api/config/test-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, model }) }).then(r => r.json()) as Promise<{ success: boolean; message: string }>,
}

// ── Component ───────────────────────────────────────────

export function ConfigPage() {
  const [profilesCfg, setProfilesCfg] = useState<ProfilesConfig | null>(null)
  const [assignments, setAssignments] = useState<ModelAssignments | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({})
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [isNewProfile, setIsNewProfile] = useState(false)
  const [showProviders, setShowProviders] = useState(false)

  useEffect(() => {
    Promise.all([api.getProfiles(), api.getAssignments()])
      .then(([p, a]) => { setProfilesCfg(p); setAssignments(a) })
      .catch(() => {})
  }, [])

  const reloadProfiles = async () => {
    const p = await api.getProfiles()
    setProfilesCfg(p)
    const a = await api.getAssignments()
    setAssignments(a)
  }

  const flashMsg = (msg: string) => {
    setSaveMsg(msg)
    setTimeout(() => setSaveMsg(null), 3000)
  }

  // ── Assignment handlers ──

  const updateAssignment = async (type: ModelType, field: 'profile' | 'model', value: string) => {
    if (!assignments) return
    const next = {
      ...assignments,
      [type]: { ...assignments[type], [field]: value },
    }
    setAssignments(next)
  }

  const saveAssignments = async () => {
    if (!assignments) return
    try {
      await api.saveAssignments(assignments)
      flashMsg('模型配置已保存')
    } catch { flashMsg('保存失败') }
  }

  // ── Test handlers ──

  const handleTest = async (type: ModelType) => {
    if (!assignments) return
    const a = assignments[type]
    setTestStatus(prev => ({ ...prev, [type]: 'testing' }))
    try {
      let result: { success: boolean; message: string }
      if (type === 'text') {
        result = await api.testLLM(a.model)
      } else if (type === 'image') {
        result = await api.testImage(a.profile, a.model)
      } else {
        result = await api.testVideo(a.profile, a.model)
      }
      setTestStatus(prev => ({ ...prev, [type]: result.success ? 'success' : 'error' }))
      setTestMessages(prev => ({ ...prev, [type]: result.message }))
    } catch {
      setTestStatus(prev => ({ ...prev, [type]: 'error' }))
      setTestMessages(prev => ({ ...prev, [type]: 'API 服务不可达' }))
    }
  }

  // ── Profile handlers ──

  const addNewProfile = (presetName: string) => {
    const p = PROVIDER_PRESETS[presetName]
    if (!p) return
    setEditingProfile({
      name: presetName,
      type: 'cloud',
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      enabled: true,
      ...p,
    })
    setIsNewProfile(true)
  }

  const handleSaveProfile = async () => {
    if (!editingProfile) return
    try {
      await api.saveProfile(editingProfile)
      await reloadProfiles()
      setEditingProfile(null)
      setIsNewProfile(false)
      flashMsg('Provider 已保存')
    } catch { flashMsg('保存失败') }
  }

  const handleActivate = async (name: string) => {
    await api.activateProfile(name)
    await reloadProfiles()
    flashMsg(`已切换到: ${name}`)
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`确定删除 "${name}"?`)) return
    await api.deleteProfile(name)
    await reloadProfiles()
  }

  // ── Render helpers ──

  const getTestBadge = (type: ModelType) => {
    const status = testStatus[type] ?? 'idle'
    if (status === 'testing') return <span className="text-xs text-muted-foreground"><Loader2 className="w-3 h-3 inline animate-spin mr-1" />测试中</span>
    if (status === 'success') return <span className="text-xs text-green-500"><CheckCircle2 className="w-3 h-3 inline mr-1" />{testMessages[type] ?? '连接成功'}</span>
    if (status === 'error') return <span className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{testMessages[type] ?? '连接失败'}</span>
    return <span className="text-xs text-muted-foreground">⚪ 未测试</span>
  }

  const filteredProfiles = (type: ModelType) =>
    (profilesCfg?.profiles ?? []).filter(p => p.enabled !== false && profileSupportsType(p, type))

  // ── Loading ──

  if (!profilesCfg || !assignments) {
    return <div className="p-6 text-muted-foreground text-sm">加载中...</div>
  }

  // ── Main render ──

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-deep-purple">
          模型配置
        </h1>
        <button onClick={saveAssignments}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-sm font-medium hover:shadow-md transition-all">
          <Zap className="w-3.5 h-3.5" /> 保存配置
        </button>
      </div>

      {/* Active profile banner */}
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-sakura/5 border border-sakura/30">
        <span className="text-xs text-muted-foreground">当前 Provider:</span>
        <span className="font-medium text-deep-purple text-sm">{profilesCfg.activeProfile || '未配置'}</span>
        {profilesCfg.profiles.find(p => p.name === profilesCfg.activeProfile) && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-sakura/20 text-sakura">active</span>
        )}
      </div>

      {/* ── Model type cards ── */}
      <div className="space-y-4">
        {(Object.keys(MODEL_TYPE_META) as ModelType[]).map(type => {
          const meta = MODEL_TYPE_META[type]
          const a = assignments[type]
          const profiles = filteredProfiles(type)
          const presets = getPresets(type, a.profile)

          return (
            <div key={type} className="border border-border rounded-2xl bg-card shadow-card overflow-hidden">
              {/* Card header */}
              <div className="px-5 py-3 border-b border-border/60 bg-muted/20">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-sm flex items-center gap-2">
                      <span>{meta.icon}</span> {meta.label}
                    </h3>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{meta.desc}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {getTestBadge(type)}
                  </div>
                </div>
              </div>

              {/* Card body */}
              <div className="px-5 py-4 space-y-3">
                {/* Provider selector */}
                <div>
                  <label className="block text-[11px] font-medium mb-1 text-muted-foreground">Provider</label>
                  <select value={a.profile}
                    onChange={(e) => updateAssignment(type, 'profile', e.target.value)}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:border-sakura/50">
                    {profiles.length === 0 && <option value="">-- 请先添加 Provider --</option>}
                    {profiles.map(p => (
                      <option key={p.name} value={p.name}>{p.name} ({p.type === 'cloud' ? 'Cloud' : 'Local'})</option>
                    ))}
                  </select>
                </div>

                {/* Model name + presets */}
                <div>
                  <label className="block text-[11px] font-medium mb-1 text-muted-foreground">模型名称</label>
                  <div className="flex gap-2">
                    <input value={a.model}
                      onChange={(e) => updateAssignment(type, 'model', e.target.value)}
                      className="flex-1 px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:border-sakura/50"
                      placeholder="输入模型名称..." />
                  </div>
                  {presets.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {presets.map(m => (
                        <button key={m}
                          onClick={() => updateAssignment(type, 'model', m)}
                          className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                            a.model === m
                              ? 'border-deep-purple bg-deep-purple/10 text-deep-purple'
                              : 'border-border hover:bg-muted text-muted-foreground'
                          }`}>
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Test button */}
                <button onClick={() => handleTest(type)}
                  disabled={testStatus[type] === 'testing' || !a.profile}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-secondary disabled:opacity-50 transition-colors">
                  {testStatus[type] === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                  测试连接
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Provider Management ── */}
      <div className="border border-border rounded-2xl bg-card shadow-card overflow-hidden">
        <button onClick={() => setShowProviders(!showProviders)}
          className="w-full px-5 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors">
          <span className="font-medium text-sm text-deep-purple">⚙️ Provider 管理</span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{profilesCfg.profiles.length} 个</span>
            {showProviders ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        </button>

        {showProviders && (
          <div className="px-5 pb-4 space-y-3">
            {/* Add buttons */}
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(PROVIDER_PRESETS).map(name => (
                <button key={name} onClick={() => addNewProfile(name)}
                  className="px-2.5 py-1 text-[10px] border border-sakura/30 rounded-lg hover:bg-sakura/10 transition-colors">
                  + {name}
                </button>
              ))}
            </div>

            {/* Profile list */}
            <div className="space-y-1.5">
              {profilesCfg.profiles.map(profile => (
                <div key={profile.name}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                    profile.name === profilesCfg.activeProfile
                      ? 'border-sakura/50 bg-sakura/5'
                      : 'border-border bg-card hover:bg-muted/20'
                  }`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-xs truncate">{profile.name}</span>
                      <span className={`px-1 py-0.5 text-[9px] rounded ${
                        profile.type === 'cloud' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-600'
                      }`}>{profile.type}</span>
                      {profile.name === profilesCfg.activeProfile && (
                        <span className="px-1 py-0.5 text-[9px] rounded bg-sakura/20 text-sakura">active</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {profile.baseUrl} | LLM: {profile.defaultModel}
                      {profile.imageModel && ` | 🎨${profile.imageModel}`}
                      {profile.videoModel && ` | 🎬${profile.videoModel}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {profile.name !== profilesCfg.activeProfile && (
                      <button onClick={() => handleActivate(profile.name)}
                        className="px-2 py-1 text-[10px] bg-sakura/10 text-deep-purple rounded hover:bg-sakura/20 transition-colors">
                        切换
                      </button>
                    )}
                    <button onClick={() => { setEditingProfile({ ...profile }); setIsNewProfile(false) }}
                      className="px-2 py-1 text-[10px] border border-border rounded hover:bg-muted transition-colors">
                      编辑
                    </button>
                    <button onClick={() => handleDelete(profile.name)}
                      className="px-1.5 py-1 text-[10px] text-destructive/60 hover:text-destructive rounded hover:bg-destructive/5 transition-colors">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              {profilesCfg.profiles.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">暂无 Provider，点击上方按钮添加</p>
              )}
            </div>

            {/* Profile editor panel */}
            {editingProfile && (
              <div className="border border-sakura/40 rounded-xl p-4 bg-muted/10 space-y-3">
                <h4 className="font-medium text-deep-purple text-xs">
                  {isNewProfile ? '新建 Provider' : `编辑: ${editingProfile.name}`}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="名称">
                    <input value={editingProfile.name} disabled={!isNewProfile}
                      onChange={e => setEditingProfile({ ...editingProfile, name: e.target.value })}
                      className="input" />
                  </Field>
                  <Field label="类型">
                    <select value={editingProfile.type}
                      onChange={e => setEditingProfile({ ...editingProfile, type: e.target.value as 'cloud' | 'local' })}
                      className="input">
                      <option value="cloud">Cloud API</option>
                      <option value="local">Local (Ollama/vLLM)</option>
                    </select>
                  </Field>
                </div>
                <Field label="API Key">
                  <input type="password" value={editingProfile.apiKey}
                    onChange={e => setEditingProfile({ ...editingProfile, apiKey: e.target.value })}
                    className="input" placeholder="sk-..." />
                </Field>
                <Field label="Base URL">
                  <input value={editingProfile.baseUrl}
                    onChange={e => setEditingProfile({ ...editingProfile, baseUrl: e.target.value })}
                    className="input" placeholder="https://api.openai.com/v1" />
                </Field>
                <Field label="文本模型">
                  <input value={editingProfile.defaultModel}
                    onChange={e => setEditingProfile({ ...editingProfile, defaultModel: e.target.value })}
                    className="input" placeholder="gpt-4o" />
                </Field>
                <Field label="图片模型（背景/立绘，留空禁用）">
                  <input value={editingProfile.imageModel ?? ''}
                    onChange={e => setEditingProfile({ ...editingProfile, imageModel: e.target.value || undefined })}
                    className="input" placeholder="agnes-image-2.1-flash" />
                </Field>
                <Field label="视频模型（动画，留空禁用）">
                  <input value={editingProfile.videoModel ?? ''}
                    onChange={e => setEditingProfile({ ...editingProfile, videoModel: e.target.value || undefined })}
                    className="input" placeholder="agnes-video-v2.0" />
                </Field>
                <div className="flex gap-2 pt-1">
                  <button onClick={handleSaveProfile}
                    className="px-4 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-xs font-medium hover:shadow-md">
                    保存
                  </button>
                  <button onClick={() => { setEditingProfile(null); setIsNewProfile(false) }}
                    className="px-3 py-1.5 border border-border rounded-lg text-xs hover:bg-secondary">
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {saveMsg && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-xl text-sm shadow-lg z-50 ${
          saveMsg.includes('失败') ? 'bg-destructive text-white' : 'bg-deep-purple text-white'
        }`}>
          {saveMsg}
        </div>
      )}
    </div>
  )
}

// ── Field helper ────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium mb-1 text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
