import { NavLink } from 'react-router'
import { Sparkles, FolderOpen, Plus, Settings } from 'lucide-react'

const links = [
  { to: '/', label: '项目列表', icon: FolderOpen },
  { to: '/projects/new', label: '新建项目', icon: Plus },
  { to: '/config', label: '模型配置', icon: Settings },
]

export function TopBar() {
  return (
    <header className="h-14 border-b border-border flex items-center px-5 gap-6 bg-gradient-to-r from-[#FAF5FF] to-[#FFF1F2]">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sakura to-lavender flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-base bg-gradient-to-r from-deep-purple to-[#9333EA] bg-clip-text text-transparent">
          All Novel Can Be Galgame
        </span>
      </div>
      <nav className="flex items-center gap-1 ml-auto">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200 ${
                isActive
                  ? 'bg-lavender/30 text-deep-purple font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-deep-purple hover:bg-lavender/10'
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
