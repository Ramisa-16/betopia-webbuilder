import React from 'react'

export default function SkillIcon({ slash, size = 13 }: { slash: string; size?: number }) {
  const key = slash.toLowerCase()
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (key === '/caveman') {
    return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>
  }
  if (key === '/debug') {
    return <svg {...common}><path d="m8 2 1.5 3" /><path d="M14.5 5 16 2" /><path d="M7 8h10" /><path d="M19 12h3" /><path d="M2 12h3" /><path d="M5 19l3-3" /><path d="m16 16 3 3" /><rect x="7" y="5" width="10" height="12" rx="5" /></svg>
  }
  if (key === '/deploy') {
    return <svg {...common}><path d="M4.5 16.5c-1.7-1.7-1.7-4.4 0-6.1l7.1-7.1 9.1 9.1-7.1 7.1c-1.7 1.7-4.4 1.7-6.1 0l-3-3z" /><path d="m9 15 6-6" /><path d="m15 9 2.5-2.5" /></svg>
  }
  if (key === '/review') {
    return <svg {...common}><path d="M4 4h16v12H7l-3 3V4z" /><path d="m8 10 2 2 5-5" /></svg>
  }
  if (key === '/test') {
    return <svg {...common}><path d="M9 2v6l-4 8a4 4 0 0 0 3.6 6h6.8A4 4 0 0 0 19 16l-4-8V2" /><path d="M8 2h8" /><path d="M7 16h10" /></svg>
  }
  return <svg {...common}><path d="M14.5 4a2.5 2.5 0 0 1 3.54 3.54L7.5 18.1 4 19l.9-3.5L14.5 4z" /></svg>
}
