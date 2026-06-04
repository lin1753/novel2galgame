import { useState } from 'react'
import { Save, Wifi } from 'lucide-react'

export function ConfigPage() {
  const [config, setConfig] = useState({
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    defaultModel: 'gpt-4o',
    imageModel: 'gpt-image-2',
    budgetMode: 'balanced',
    timeout: 60,
    retryCount: 2,
  })
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/config/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json()
      setTestResult(data.success ? '连接成功' : `连接失败: ${data.message}`)
    } catch {
      setTestResult('API 服务未启动或不可达')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    try {
      await fetch('/api/config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      alert('配置已保存')
    } catch {
      alert('保存失败，请确保 API 服务正在运行')
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">模型与 API 配置</h1>
      <p className="text-sm text-muted-foreground mb-6">
        工作台在本地运行，AI 功能依赖外部 API。文本和项目数据保存在本地。
      </p>

      <div className="space-y-4">
        <Field label="API 提供商">
          <select
            value={config.provider}
            onChange={(e) => setConfig({ ...config, provider: e.target.value })}
            className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic (即将支持)</option>
          </select>
        </Field>

        <Field label="API Key">
          <input
            type="password"
            value={config.apiKey}
            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
            className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            placeholder="sk-..."
          />
        </Field>

        <Field label="自定义 Base URL (可选)">
          <input
            type="text"
            value={config.baseUrl}
            onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
            className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="文本模型">
            <input
              type="text"
              value={config.defaultModel}
              onChange={(e) => setConfig({ ...config, defaultModel: e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            />
          </Field>
          <Field label="图像模型">
            <input
              type="text"
              value={config.imageModel}
              onChange={(e) => setConfig({ ...config, imageModel: e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            />
          </Field>
        </div>

        <Field label="预算模式">
          <select
            value={config.budgetMode}
            onChange={(e) => setConfig({ ...config, budgetMode: e.target.value })}
            className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
          >
            <option value="high_quality">高质量</option>
            <option value="balanced">均衡</option>
            <option value="budget">省钱</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="超时 (秒)">
            <input
              type="number"
              value={config.timeout}
              onChange={(e) => setConfig({ ...config, timeout: +e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            />
          </Field>
          <Field label="重试次数">
            <input
              type="number"
              value={config.retryCount}
              onChange={(e) => setConfig({ ...config, retryCount: +e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground"
            />
          </Field>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-2 px-4 py-2 border border-border rounded hover:bg-secondary disabled:opacity-50"
          >
            <Wifi className="w-4 h-4" />
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded hover:opacity-90"
          >
            <Save className="w-4 h-4" /> 保存配置
          </button>
        </div>

        {testResult && (
          <div className={`p-3 rounded text-sm ${testResult.includes('成功') ? 'bg-green-500/10 text-green-400' : 'bg-destructive/10 text-destructive'}`}>
            {testResult}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
    </div>
  )
}
