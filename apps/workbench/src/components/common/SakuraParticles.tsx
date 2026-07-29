import { useMemo } from 'react'

interface Petal {
  id: number
  left: number
  delay: number
  duration: number
  size: number
  opacity: number
}

export function SakuraParticles() {
  const petals = useMemo<Petal[]>(() => {
    return Array.from({ length: 12 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 10,
      duration: 8 + Math.random() * 7,
      size: 8 + Math.random() * 8,
      opacity: 0.15 + Math.random() * 0.2,
    }))
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-50">
      {petals.map((p) => (
        <div
          key={p.id}
          className="absolute animate-[sakura-fall_linear_infinite]"
          style={{
            left: `${p.left}%`,
            top: '-20px',
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            opacity: p.opacity,
          }}
        >
          {/* SVG cherry blossom petal */}
          <svg
            width={p.size}
            height={p.size}
            viewBox="0 0 24 24"
            fill="none"
            style={{ filter: 'blur(0.3px)' }}
          >
            <path
              d="M12 2C10 6 6 8 2 8c0 4 2 8 6 10 0-2 2-4 4-6 2 2 4 4 4 6 4-2 6-6 6-10-4 0-8-2-10-6z"
              fill="#F5B7D1"
              opacity="0.8"
            />
          </svg>
        </div>
      ))}
    </div>
  )
}
