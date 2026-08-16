import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Brain,
  User,
  Sparkles,
  BookOpen,
  Layers,
  ChevronRight,
  Search,
  Database,
  ArrowLeft,
  Tag,
  FileText,
  RefreshCw,
} from 'lucide-react'
import { projectService } from '../services/projects'

export function RagInspectorPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [selectedChar, setSelectedChar] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const { data: ragData, isLoading, isError, refetch } = useQuery({
    queryKey: ['rag-characters', projectId],
    queryFn: () => projectService.getRagCharacters(projectId!),
    enabled: !!projectId,
  })

  const rawCharacters = ragData?.characters ?? []
  const characters = Array.isArray(rawCharacters)
    ? rawCharacters.filter((c) => c && typeof c === 'object' && Boolean(c.canonicalName))
    : []

  const filteredChars = characters.filter((c) => {
    const name = String(c?.canonicalName ?? '').toLowerCase()
    return name.includes(searchQuery.toLowerCase())
  })

  const activeChar =
    characters.find((c) => c?.canonicalName === selectedChar) ||
    filteredChars[0] ||
    null

  return (
    <div className="flex flex-col h-full -m-6 p-6 bg-background/50">
      {/* Top Header Bar */}
      <div className="flex items-center justify-between pb-4 border-b border-border/40 mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-primary/10 text-primary rounded-xl border border-primary/20 shadow-sm">
            <Brain className="w-5 h-5 animate-pulse text-sakura" />
          </div>
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              角色记忆档案库 (RAG Knowledge Inspector)
              <span className="px-2 py-0.5 text-[10px] font-mono bg-sakura/20 text-deep-purple rounded-full border border-sakura/30">
                ChromaDB + SQLite
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Agent 跨章节人设记忆中枢 · 向量检索与外观设定全景视图
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-background/80 border border-border/60 rounded-xl text-xs text-muted-foreground shadow-sm">
            <Database className="w-3.5 h-3.5 text-emerald-500" />
            <span>已收录角色: <strong className="text-foreground">{characters.length}</strong> 位</span>
          </div>
          <button
            onClick={() => refetch()}
            className="px-3 py-1.5 bg-gradient-to-r from-sakura to-sakura-dark hover:opacity-90 text-deep-purple text-xs font-medium rounded-xl shadow-sm transition-all flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> 刷新记忆
          </button>
        </div>
      </div>

      {/* Main Split Body */}
      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Left Sidebar: Character List */}
        <div className="w-72 border border-border/40 rounded-2xl glass-subtle flex flex-col overflow-hidden shrink-0 shadow-sm">
          {/* Search */}
          <div className="p-3 border-b border-border/40 bg-background/40">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索角色名..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-background/80 border border-border/60 rounded-xl pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-sakura transition-colors"
              />
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {isLoading ? (
              <div className="p-6 text-center text-muted-foreground text-xs">加载记忆档案中...</div>
            ) : filteredChars.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-xs leading-relaxed">
                暂无已收录角色档案<br />
                <span className="text-[11px] text-muted-foreground/60">（运行章节管线后将自动提取）</span>
              </div>
            ) : (
              filteredChars.map((char) => {
                const charName = char?.canonicalName ?? '未知角色'
                const isSelected = activeChar?.canonicalName === charName
                return (
                  <button
                    key={charName}
                    onClick={() => setSelectedChar(charName)}
                    className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-gradient-to-r from-sakura/20 to-sakura/10 border border-sakura/30 text-deep-purple font-medium shadow-sm'
                        : 'hover:bg-white/40 text-muted-foreground hover:text-foreground border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                          isSelected ? 'bg-sakura text-deep-purple' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {charName.slice(0, 1)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs truncate font-medium">{charName}</div>
                        <div className="text-[10px] text-muted-foreground/80 flex items-center gap-1.5 mt-0.5">
                          <span>{char.chapters?.length ?? 1} 章出场</span>
                          <span>·</span>
                          <span>{char.chunkCount ?? 0} 切片</span>
                        </div>
                      </div>
                    </div>
                    <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-deep-purple' : 'text-muted-foreground/40'}`} />
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 border border-border/40 rounded-2xl glass-subtle p-6 overflow-y-auto shadow-sm space-y-6">
          {activeChar ? (
            <div className="space-y-6 max-w-3xl">
              {/* Profile Card */}
              <div className="p-5 rounded-xl bg-background/60 border border-border/60 shadow-sm space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-sakura-dark via-sakura to-sakura-light flex items-center justify-center text-deep-purple text-xl font-bold shadow-sm">
                      {String(activeChar.canonicalName ?? '').slice(0, 1) || '角'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h2 className="text-lg font-bold text-foreground">{activeChar.canonicalName}</h2>
                        {activeChar.characterId && (
                          <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-muted text-muted-foreground border border-border/40">
                            {activeChar.characterId}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5 text-sakura" />
                        出场章节: {Array.isArray(activeChar.chapters) && activeChar.chapters.length > 0 ? activeChar.chapters.join(', ') : '第 1 章'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Appearance Section */}
                <div className="pt-4 border-t border-border/40">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-deep-purple/80 mb-2">
                    <Sparkles className="w-3.5 h-3.5 text-sakura" />
                    <span>跨章节外观基准记忆 (Visual Prompt Memory)</span>
                  </div>
                  {Array.isArray(activeChar.appearances) && activeChar.appearances.length > 0 ? (
                    <div className="p-3 bg-background/80 rounded-xl border border-border/60 text-xs text-foreground leading-relaxed">
                      {activeChar.appearances.join('； ')}
                    </div>
                  ) : (
                    <div className="p-3 bg-background/40 rounded-xl border border-border/40 text-xs text-muted-foreground italic">
                      暂无显式外观特征提取（管线解析后续章节时将自动动态扩充）
                    </div>
                  )}
                </div>

                {/* Personality Section */}
                {Array.isArray(activeChar.personalities) && activeChar.personalities.length > 0 && (
                  <div className="pt-3 border-t border-border/40">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-deep-purple/80 mb-2">
                      <Tag className="w-3.5 h-3.5 text-sakura" />
                      <span>性格与语气特征 (Personality Traits)</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {activeChar.personalities.map((p, idx) => (
                        <span
                          key={idx}
                          className="px-2.5 py-1 bg-sakura/10 border border-sakura/20 text-deep-purple text-xs rounded-lg font-medium"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Memory Progression Timeline */}
              {Array.isArray(activeChar.timeline) && activeChar.timeline.length > 0 && (
                <div className="p-5 rounded-xl bg-background/60 border border-border/60 shadow-sm space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-sakura" />
                      <h3 className="font-bold text-foreground text-sm">
                        跨章节记忆流转演变 (Memory Timeline)
                      </h3>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      按章节递进沉淀
                    </span>
                  </div>

                  <div className="space-y-3 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-0.5 before:bg-border/60">
                    {activeChar.timeline.map((item, idx) => (
                      <div key={idx} className="flex items-start gap-3 relative">
                        <div className="w-6 h-6 rounded-full bg-sakura/20 border border-sakura text-deep-purple text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5 z-10">
                          {idx + 1}
                        </div>
                        <div className="flex-1 p-3 bg-background/80 border border-border/60 rounded-xl space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-foreground">{item.chapterTitle}</span>
                            <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground uppercase">{item.traitKind}</span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed">{item.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Vector Chunks Section */}
              <div className="p-5 rounded-xl bg-background/60 border border-border/60 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-sakura" />
                    <h3 className="font-bold text-foreground text-sm">
                      向量切片溯源 (ChromaDB + BM25 Vector Chunks)
                    </h3>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    共收录 {activeChar.chunks?.length ?? 0} 条原文线索
                  </span>
                </div>

                <div className="space-y-2.5">
                  {Array.isArray(activeChar.chunks) && activeChar.chunks.length > 0 ? (
                    activeChar.chunks.map((chunk, idx) => (
                      <div
                        key={idx}
                        className="p-3.5 bg-background/80 border border-border/60 rounded-xl space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span className="font-mono text-[11px] text-deep-purple flex items-center gap-1">
                            <FileText className="w-3 h-3 text-sakura" /> 章节: {chunk.chapterId || '当前章'}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground uppercase">
                            {chunk.chunkType || 'appearance'}
                          </span>
                        </div>
                        <p className="text-xs text-foreground leading-relaxed">{chunk.text}</p>
                      </div>
                    ))
                  ) : (
                    <div className="p-6 text-center text-muted-foreground text-xs">
                      暂无原始切片数据
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-2">
              <Brain className="w-8 h-8 text-muted-foreground/40 stroke-1" />
              <span>请在左侧选择一位角色查看其 RAG 记忆档案</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
