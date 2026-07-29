import { NavLink } from 'react-router'
import { FolderOpen, Plus, Settings } from 'lucide-react'

const links = [
  { to: '/', label: '项目列表', icon: FolderOpen },
  { to: '/projects/new', label: '新建项目', icon: Plus },
  { to: '/config', label: '模型配置', icon: Settings },
]

function LogoIcon() {
  return (
    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sakura to-[#D4A89C] flex items-center justify-center shadow-sm">
      {/* Book + Quill icon — novel to galgame */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <path d="M8 7h6" />
        <path d="M8 11h4" />
      </svg>
    </div>
  )
}

export function TopBar() {
  return (
    <header className="h-14 border-b border-white/40 flex items-center px-5 gap-6 glass-subtle">
      <div className="flex items-center gap-2.5">
        <LogoIcon />
        <span className="font-bold text-base text-deep-purple">
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
                  ? 'bg-sakura/20 text-deep-purple font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-deep-purple hover:bg-sakura/10'
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
