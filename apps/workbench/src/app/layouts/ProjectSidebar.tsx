import { NavLink, useParams } from 'react-router'
import {
  LayoutDashboard,
  FileText,
  Layers,
  Film,
  ScrollText,
  Images,
  Play,
  ListTodo,
  Settings,
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
    <aside className="w-48 border-r border-border bg-sidebar flex flex-col py-2 shrink-0">
      <nav className="flex flex-col gap-0.5 px-2">
        {projectLinks.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={`${base}/${to}`}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50'
              }`
            }
          >
            <Icon className="w-4 h-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
