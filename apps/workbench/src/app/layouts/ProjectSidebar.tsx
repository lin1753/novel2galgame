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
  Pencil,
  Brain,
} from 'lucide-react'

const projectLinks = [
  { to: 'overview', label: '项目总览', icon: LayoutDashboard },
  { to: 'chapters', label: '章节管理', icon: FileText },
  { to: 'scenes', label: '场景工作区', icon: Layers },
  { to: 'script', label: 'VN 脚本', icon: ScrollText },
  { to: 'prompts', label: '视觉提示', icon: Images },
  { to: 'rag', label: '角色记忆 (RAG)', icon: Brain },
  { to: 'assets', label: '资产管理', icon: Images },
  { to: 'preview', label: '预览播放', icon: Play },
  { to: 'editor', label: '场景编辑', icon: Pencil },
  { to: 'tasks', label: '任务日志', icon: ListTodo },
  { to: 'settings', label: '项目设置', icon: Settings },
]

export function ProjectSidebar() {
  const { projectId } = useParams<{ projectId: string }>()
  const base = `/projects/${projectId}`

  return (
    <aside className="w-52 border-r border-white/40 glass-subtle flex flex-col py-3 shrink-0">
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
                  ? 'bg-gradient-to-r from-sakura/20 to-sakura/10 text-deep-purple font-medium shadow-sm border border-sakura/20'
                  : 'text-muted-foreground hover:text-deep-purple hover:bg-sakura/10'
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
