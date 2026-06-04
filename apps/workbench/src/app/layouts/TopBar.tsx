import { NavLink } from 'react-router'
import { FolderOpen, Plus, Settings, BookOpen } from 'lucide-react'

const links = [
  { to: '/', label: '项目列表', icon: FolderOpen },
  { to: '/projects/new', label: '新建项目', icon: Plus },
  { to: '/config', label: '模型配置', icon: Settings },
]

export function TopBar() {
  return (
    <header className="h-12 border-b border-border flex items-center px-4 gap-6 bg-sidebar">
      <div className="flex items-center gap-2 text-primary font-bold text-sm">
        <BookOpen className="w-5 h-5" />
        <span>All Novel Can Be Galgame</span>
      </div>
      <nav className="flex items-center gap-1">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50'
              }`
            }
          >
            <Icon className="w-4 h-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
