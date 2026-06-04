import { useParams } from 'react-router'

export function VNScriptPage() {
  const { sceneId } = useParams()
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <div className="text-center">
        <p className="text-lg mb-2">VN 脚本查看器</p>
        <p className="text-sm">场景: {sceneId}</p>
        <p className="text-sm mt-2 opacity-60">Phase 3: 完整脚本渲染即将推出</p>
      </div>
    </div>
  )
}
