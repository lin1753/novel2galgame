import { BrowserRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GlobalLayout, ProjectLayout } from './layouts/Layouts'
import { ProjectListPage } from '@/pages/ProjectListPage'
import { NewProjectPage } from '@/pages/NewProjectPage'
import { ProjectOverviewPage } from '@/pages/ProjectOverviewPage'
import { ChaptersPage } from '@/pages/ChaptersPage'
import { ScenesPage } from '@/pages/ScenesPage'
import { ConfigPage } from '@/pages/ConfigPage'
import { VNScriptPage } from '@/pages/VNScriptPage'
import { TasksPage } from '@/pages/TasksPage'
import { ProjectSettingsPage } from '@/pages/ProjectSettingsPage'
import { PreviewPage } from '@/pages/PreviewPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1 },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-background text-foreground">
          <Routes>
            <Route element={<GlobalLayout />}>
              <Route path="/" element={<ProjectListPage />} />
              <Route path="/projects/new" element={<NewProjectPage />} />
              <Route path="/config" element={<ConfigPage />} />
            </Route>
            <Route path="/projects/:projectId" element={<ProjectLayout />}>
              <Route path="overview" element={<ProjectOverviewPage />} />
              <Route path="chapters" element={<ChaptersPage />} />
              <Route path="scenes/:chapterId" element={<ScenesPage />} />
              <Route path="script/:sceneId" element={<VNScriptPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="settings" element={<ProjectSettingsPage />} />
              <Route path="preview" element={<PreviewPage />} />
              <Route index element={<ProjectOverviewPage />} />
            </Route>
          </Routes>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
