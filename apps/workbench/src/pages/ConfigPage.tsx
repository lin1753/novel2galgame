import { useState, useEffect } from 'react'
import { Save, Loader2, Key, Link2, Cpu, Image as ImageIcon, Film, Plus, Trash2, CheckCircle2 } from 'lucide-react'

export function ConfigPage() {
  const [profiles, setProfiles] = useState<any[]>([])
  const [activeProfileName, setActiveProfileName] = useState<string>('')
  const [formData, setFormData] = useState<any>(null)
  
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const loadData = () => {
    fetch('http://localhost:3002/config/profiles')
      .then(res => res.json())
      .then(data => {
        setProfiles(data.profiles || [])
        setActiveProfileName(data.activeProfile)
        const active = data.profiles?.find((p: any) => p.name === data.activeProfile)
        if (active) {
          setFormData({
            ...active,
            imageModel: active.imageModel || '',
            videoModel: active.videoModel || ''
          })
        }
      })
      .catch(err => console.error("Failed to load config", err))
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleSelectProfile = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value
    if (!name) return
    setSaving(true)
    try {
      await fetch(`http://localhost:3002/config/profiles/${name}/activate`, { method: 'POST' })
      loadData()
      setMsg('已切换配置方案！')
      setTimeout(() => setMsg(''), 2000)
    } catch (err) {
      setMsg('切换失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateNew = async () => {
    const name = window.prompt("请输入新配置方案的名称：", "my-new-profile")
    if (!name) return
    if (profiles.find(p => p.name === name)) {
      window.alert("该名称已存在！")
      return
    }
    const newProfile = {
      name,
      type: 'cloud',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      defaultModel: 'gpt-4o',
      imageModel: '',
      videoModel: ''
    }
    setSaving(true)
    try {
      await fetch('http://localhost:3002/config/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProfile)
      })
      await fetch(`http://localhost:3002/config/profiles/${name}/activate`, { method: 'POST' })
      loadData()
    } catch (err) {
      setMsg('创建失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (profiles.length <= 1) {
      window.alert("至少需要保留一个配置方案！")
      return
    }
    if (!window.confirm(`确定要删除配置方案 "${activeProfileName}" 吗？`)) return
    
    setSaving(true)
    try {
      await fetch(`http://localhost:3002/config/profiles/${activeProfileName}`, { method: 'DELETE' })
      // Activate the first available one
      const remaining = profiles.filter(p => p.name !== activeProfileName)
      if (remaining.length > 0) {
        await fetch(`http://localhost:3002/config/profiles/${remaining[0].name}/activate`, { method: 'POST' })
      }
      loadData()
      setMsg('已删除')
      setTimeout(() => setMsg(''), 2000)
    } catch (err) {
      setMsg('删除失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (!formData) return
    setSaving(true)
    try {
      const res = await fetch('http://localhost:3002/config/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      if (res.ok) {
        setMsg('配置保存成功！')
        setTimeout(() => setMsg(''), 3000)
        loadData()
      } else {
        setMsg('保存失败')
        setTimeout(() => setMsg(''), 3000)
      }
    } catch (err) {
      setMsg('保存失败: 网络错误')
      setTimeout(() => setMsg(''), 3000)
    } finally {
      setSaving(false)
    }
  }

  if (!formData) return <div className="p-6 flex justify-center"><Loader2 className="animate-spin text-sakura w-6 h-6" /></div>

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-deep-purple">
          模型与接口配置
        </h1>
        <div className="flex items-center gap-3">
          {saving && <Loader2 className="w-4 h-4 animate-spin text-sakura" />}
          <div className="flex items-center bg-card border border-border/60 rounded-xl p-1 shadow-sm">
            <select 
              value={activeProfileName} 
              onChange={handleSelectProfile}
              className="bg-transparent border-none text-sm font-medium focus:ring-0 text-deep-purple py-1.5 pl-3 pr-8 cursor-pointer"
            >
              {profiles.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <div className="w-px h-5 bg-border/60 mx-1"></div>
            <button onClick={handleCreateNew} title="新建配置" className="p-1.5 hover:bg-sakura/10 rounded-lg text-deep-purple transition-colors">
              <Plus className="w-4 h-4" />
            </button>
            <button onClick={handleDelete} title="删除当前配置" className="p-1.5 hover:bg-destructive/10 rounded-lg text-destructive transition-colors">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="bg-card shadow-card border border-border/60 rounded-2xl overflow-hidden">
        <div className="bg-muted/20 border-b border-border/60 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-deep-purple">
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            当前正在编辑: {activeProfileName}
          </div>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-5 py-1.5 bg-gradient-to-r from-sakura to-lavender text-white rounded-lg text-sm font-medium hover:shadow-md disabled:opacity-50 transition-all">
            <Save className="w-3.5 h-3.5" />
            保存修改
          </button>
        </div>
        
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 gap-6">
            <Field label="API Key" icon={<Key className="w-4 h-4 text-muted-foreground" />}>
              <input type="password" value={formData.apiKey}
                onChange={e => setFormData({ ...formData, apiKey: e.target.value })}
                className="input w-full" placeholder="sk-..." />
            </Field>
            
            <Field label="Base URL (接口地址)" icon={<Link2 className="w-4 h-4 text-muted-foreground" />}>
              <input value={formData.baseUrl}
                onChange={e => setFormData({ ...formData, baseUrl: e.target.value })}
                className="input w-full" placeholder="https://api.openai.com/v1" />
            </Field>
            
            <div className="h-px bg-border/60 w-full my-2"></div>
            
            <Field label="默认文本大模型 (用于叙事与逻辑)" icon={<Cpu className="w-4 h-4 text-muted-foreground" />}>
              <input value={formData.defaultModel}
                onChange={e => setFormData({ ...formData, defaultModel: e.target.value })}
                className="input w-full" placeholder="gpt-4o" />
            </Field>
            
            <Field label="默认图像大模型 (用于生成立绘与背景)" icon={<ImageIcon className="w-4 h-4 text-muted-foreground" />}>
              <input value={formData.imageModel}
                onChange={e => setFormData({ ...formData, imageModel: e.target.value })}
                className="input w-full" placeholder="留空则禁用" />
            </Field>
            
            <Field label="默认视频大模型 (用于生成过场动画)" icon={<Film className="w-4 h-4 text-muted-foreground" />}>
              <input value={formData.videoModel}
                onChange={e => setFormData({ ...formData, videoModel: e.target.value })}
                className="input w-full" placeholder="留空则禁用" />
            </Field>
          </div>
        </div>
      </div>

      {msg && (
        <div className={`fixed bottom-6 right-6 px-6 py-3 rounded-xl text-sm shadow-xl z-50 transition-all ${
          msg.includes('失败') ? 'bg-destructive text-white' : 'bg-deep-purple text-white'
        }`}>
          {msg}
        </div>
      )}
    </div>
  )
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm font-medium text-deep-purple">
        {icon}
        {label}
      </label>
      {children}
    </div>
  )
}
