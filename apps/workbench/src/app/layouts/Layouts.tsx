import { Outlet } from 'react-router'
import { TopBar } from './TopBar'
import { ProjectSidebar } from './ProjectSidebar'

export function ProjectLayout() {
  return (
    <div className="h-screen flex flex-col">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function GlobalLayout() {
  return (
    <div className="h-screen flex flex-col">
      <TopBar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
