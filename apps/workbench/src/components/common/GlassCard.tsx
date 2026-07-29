import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface GlassCardProps {
  children: ReactNode
  className?: string
  hover?: boolean
}

export function GlassCard({ children, className, hover = true }: GlassCardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/40 bg-white/60 backdrop-blur-sm shadow-card',
        hover && 'transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover hover:border-sakura/30',
        className
      )}
    >
      {children}
    </div>
  )
}
