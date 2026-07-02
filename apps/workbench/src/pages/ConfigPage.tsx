import { useState, useEffect } from 'react'
import { Save, Wifi, Plus, Trash2, CheckCircle2, Loader2, AlertCircle } from 'lucide-react'

interface Profile {
  name: string
  type: 'cloud' | 'local'
  baseUrl: string
  apiKey: string
  defaultModel: string
  enabled: boolean
}

interface ProfilesConfig {
  profiles: Profile[]
  activeProfile: string
}

const PROVIDER_PRESETS: Record<string, Partial<Profile>> = {
  'agnes': { baseUrl: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash', type: 'cloud' },
  'openai': { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', type: 'cloud' },
  'deepseek': { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', type: 'cloud' },
  'moonshot': { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', type: 'cloud' },
  'zhipu': { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', type: 'cloud' },
  'local': { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen3-8b', type: 'local' },
}

export function ConfigPage() {
  const [config, setConfig] = useState<ProfilesConfig | null>(null)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [isNewProfile, setIsNewProfile] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/config/profiles')
      .then(r => r.json())
      .then((data: ProfilesConfig) => setConfig(data))
      .catch(() => setConfig({ profiles: [], activeProfile: '' }))
  }, [])

  const handleSave = async () => {
    if (!editingProfile || !config) return
    try {
      // Save profile
      await fetch('/api/config/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingProfile),
      })
      // Reload config
      const res = await fetch('/api/config/profiles')
      const newConfig: ProfilesConfig = await res.json()
      setConfig(newConfig)
      setEditingProfile(null)
      setIsNewProfile(false)
      setSaveResult('配置已保存')
      setTimeout(() => setSaveResult(null), 3000)
    } catch {
      setSaveResult('保存失败')
    }
  }

  const handleActivate = async (name: string) => {
    try {
      await fetch(`/api/config/profiles/${name}/activate`, { method: 'POST' })
      const res = await fetch('/api/config/profiles')
      setConfig(await res.json())
      setSaveResult(`已切换到: ${name}`)
      setTimeout(() => setSaveResult(null), 3000)
    } catch {
      setSaveResult('切换失败')
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`确定删除 profile "${name}"?`)) return
    try {
      await fetch(`/api/config/profiles/${name}`, { method: 'DELETE' })
      const res = await fetch('/api/config/profiles')
      setConfig(await res.json())
    } catch {}
  }

  const handleTest = async () => {
    if (!editingProfile) return
    setTesting(true)
    setTestResult(null)
    try {
      // Temporarily activate this profile for testing
      const res = await fetch('/api/config/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: editingProfile.defaultModel }),
      })
      const data = await res.json()
      setTestResult(data.success ? '✅ 连接成功' : `❌ ${data.message}`)
    } catch {
      setTestResult('❌ API 服务不可达')
    } finally {
      setTesting(false)
    }
  }

  const addNewProfile = (preset: string) => {
    const p = PROVIDER_PRESETS[preset]
    const newProfile: Profile = {
      name: preset,
      type: 'cloud',
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      enabled: true,
      ...p,
    }
    setEditingProfile(newProfile)
    setIsNewProfile(true)
    setTestResult(null)
  }

  if (!config) return <div className="p-6 text-muted-foreground">加载中...</div>

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-bold bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent">
        模型配置
      </h1>

      {/* Active profile indicator */}
      <div className="p-3 rounded-xl bg-card border border-border">
        <span className="text-xs text-muted-foreground">当前使用: </span>
        <span className="font-medium text-deep-purple">{config.activeProfile || '未配置'}</span>
        {config.profiles.find(p => p.name === config.activeProfile) && (
          <span className="text-xs text-muted-foreground ml-2">
            ({config.profiles.find(p => p.name === config.activeProfile)?.defaultModel})
          </span>
        )}
      </div>

      {/* Profile list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-deep-purple">已配置模型</h2>
          <div className="flex flex-wrap gap-1">
            {Object.keys(PROVIDER_PRESETS).map(preset => (
              <button key={preset} onClick={() => addNewProfile(preset)}
                className="px-2 py-1 text-[10px] border border-lavender/30 rounded hover:bg-lavender/10 transition-colors">
                + {preset}
              </button>
            ))}
          </div>
        </div>

        {config.profiles.map(profile => (
          <div key={profile.name}
            className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
              profile.name === config.activeProfile
                ? 'border-lavender bg-lavender/5'
                : 'border-border bg-card hover:bg-muted/30'
            }`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{profile.name}</span>
                <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                  profile.type === 'cloud' ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'
                }`}>{profile.type}</span>
                {profile.name === config.activeProfile && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-sakura/20 text-sakura">使用中</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {profile.baseUrl} | {profile.defaultModel}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {profile.name !== config.activeProfile && (
                <button onClick={() => handleActivate(profile.name)}
                  className="px-2 py-1 text-[10px] bg-lavender/10 text-deep-purple rounded hover:bg-lavender/20 transition-colors">
                  切换
                </button>
              )}
              <button onClick={() => { setEditingProfile({...profile}); setIsNewProfile(false); setTestResult(null) }}
                className="px-2 py-1 text-[10px] border border-border rounded hover:bg-muted transition-colors">
                编辑
              </button>
              <button onClick={() => handleDelete(profile.name)}
                className="px-2 py-1 text-[10px] text-destructive/60 hover:text-destructive rounded hover:bg-destructive/5 transition-colors">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}

        {config.profiles.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            暂无配置，点击上方按钮添加
          </p>
        )}
      </div>

      {/* Edit panel */}
      {editingProfile && (
        <div className="border border-lavender/40 rounded-2xl p-5 bg-card shadow-card space-y-4">
          <h3 className="font-medium text-deep-purple text-sm">
            {isNewProfile ? '新建配置' : `编辑: ${editingProfile.name}`}
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <Field label="名称">
              <input value={editingProfile.name} disabled={!isNewProfile}
                onChange={(e) => setEditingProfile({...editingProfile, name: e.target.value})}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm disabled:opacity-50" />
            </Field>
            <Field label="类型">
              <select value={editingProfile.type}
                onChange={(e) => setEditingProfile({...editingProfile, type: e.target.value as 'cloud' | 'local'})}
                className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm">
                <option value="cloud">Cloud API</option>
                <option value="local">Local (Ollama/vLLM)</option>
              </select>
            </Field>
          </div>

          <Field label="API Key">
            <input type="password" value={editingProfile.apiKey}
              onChange={(e) => setEditingProfile({...editingProfile, apiKey: e.target.value})}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm"
              placeholder="sk-..." />
          </Field>

          <Field label="Base URL">
            <input value={editingProfile.baseUrl}
              onChange={(e) => setEditingProfile({...editingProfile, baseUrl: e.target.value})}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm"
              placeholder="https://api.openai.com/v1" />
          </Field>

          <Field label="默认模型">
            <input value={editingProfile.defaultModel}
              onChange={(e) => setEditingProfile({...editingProfile, defaultModel: e.target.value})}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm"
              placeholder="gpt-4o" />
          </Field>

          <div className="flex gap-2 pt-2">
            <button onClick={handleTest} disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-secondary disabled:opacity-50">
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
              测试连接
            </button>
            <button onClick={handleSave}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-sm font-medium hover:shadow-md transition-all">
              <Save className="w-3.5 h-3.5" /> 保存
            </button>
            <button onClick={() => { setEditingProfile(null); setIsNewProfile(false) }}
              className="px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-secondary transition-colors">
              取消
            </button>
          </div>

          {testResult && (
            <p className={`text-xs ${testResult.includes('成功') ? 'text-green-500' : 'text-destructive'}`}>
              {testResult}
            </p>
          )}
        </div>
      )}

      {saveResult && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-xl text-sm shadow-lg ${
          saveResult.includes('失败') ? 'bg-destructive text-white' : 'bg-deep-purple text-white'
        }`}>
          {saveResult}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1 text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
