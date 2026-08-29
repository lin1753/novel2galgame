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

import { PreviewPage } from '@/pages/PreviewPage'
import { VisualPromptPage } from '@/pages/VisualPromptPage'
import { EditorPage } from '@/pages/EditorPage'
import { AssetsPage } from '@/pages/AssetsPage'
import { RagInspectorPage } from '@/pages/RagInspectorPage'

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
              <Route path="scenes" element={<ScenesPage />} />
              <Route path="scenes/:chapterId" element={<ScenesPage />} />
              <Route path="script" element={<VNScriptPage />} />
              <Route path="script/:sceneId" element={<VNScriptPage />} />
              <Route path="prompts" element={<VisualPromptPage />} />
              <Route path="rag" element={<RagInspectorPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="preview" element={<PreviewPage />} />
              <Route path="editor" element={<EditorPage />} />
              <Route path="editor/:sceneId" element={<EditorPage />} />
              <Route path="assets" element={<AssetsPage />} />
              <Route index element={<ProjectOverviewPage />} />
            </Route>
          </Routes>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
