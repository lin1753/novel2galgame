import { NavLink, useParams } from 'react-router'
import {
  LayoutDashboard,
  FileText,
  Layers,
  ScrollText,
  Images,
  Play,
  ListTodo,
  Settings,
  Sparkles,
} from 'lucide-react'

const projectLinks = [
  { to: 'overview', label: '项目总览', icon: LayoutDashboard },
  { to: 'chapters', label: '章节管理', icon: FileText },
  { to: 'scenes', label: '场景工作区', icon: Layers },
  { to: 'script', label: 'VN 脚本', icon: ScrollText },
  { to: 'prompts', label: '视觉提示', icon: Images },
  { to: 'preview', label: '预览播放', icon: Play },
  { to: 'tasks', label: '任务日志', icon: ListTodo },
  { to: 'settings', label: '项目设置', icon: Settings },
]

export function ProjectSidebar() {
  const { projectId } = useParams<{ projectId: string }>()
  const base = `/projects/${projectId}`

  return (
    <aside className="w-52 border-r border-border bg-gradient-to-b from-[#FAF5FF] to-white flex flex-col py-3 shrink-0">
      {/* Decorative header */}
      <div className="px-4 mb-3 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sakura animate-sparkle" />
        <span className="text-xs font-medium text-deep-purple/60 uppercase tracking-wider">导航</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {projectLinks.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={`${base}/${to}`}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                isActive
                  ? 'bg-gradient-to-r from-lavender/20 to-sakura/10 text-deep-purple font-medium shadow-sm border border-lavender/20'
                  : 'text-muted-foreground hover:text-deep-purple hover:bg-lavender/10'
              }`
            }
          >
            <Icon className="w-4 h-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Bottom decorative element */}
      <div className="mt-auto px-4 py-3">
        <div className="rounded-xl bg-gradient-to-br from-sakura/10 to-lavender/10 p-3 text-center">
          <p className="text-[10px] text-deep-purple/40">AI 驱动视觉小说生成平台</p>
        </div>
      </div>
    </aside>
  )
}
