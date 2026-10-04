import type { AgentIconId } from '@/lib/agents'

const ICON_SVG: Record<AgentIconId, JSX.Element> = {
  coder: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5,4 2,8 5,12" /><polyline points="11,4 14,8 11,12" /><line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  ),
  architect: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="5" width="4" height="4" rx="0.5" /><rect x="11" y="5" width="4" height="4" rx="0.5" />
      <rect x="6" y="1" width="4" height="4" rx="0.5" /><rect x="6" y="11" width="4" height="4" rx="0.5" />
      <line x1="5" y1="7" x2="6" y2="7" /><line x1="10" y1="7" x2="11" y2="7" />
      <line x1="8" y1="5" x2="8" y2="6" /><line x1="8" y1="10" x2="8" y2="11" />
    </svg>
  ),
  reviewer: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5l-3-3z" />
      <polyline points="9,2 9,6 13,6" /><line x1="5" y1="9" x2="11" y2="9" /><line x1="5" y1="11.5" x2="9" y2="11.5" />
    </svg>
  ),
  security: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1L2 4v4c0 3.3 2.5 6.4 6 7 3.5-.6 6-3.7 6-7V4L8 1z" />
      <polyline points="5.5,8 7,9.5 10.5,6" />
    </svg>
  ),
  designer: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4 8 Q6 5 8 8 Q10 11 12 8" />
      <circle cx="8" cy="3" r="1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z" />
    </svg>
  ),
  orchestration: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="2.5" r="1.5" />
      <circle cx="2.5" cy="13" r="1.5" />
      <circle cx="13.5" cy="13" r="1.5" />
      <line x1="8" y1="4" x2="2.5" y2="11.5" />
      <line x1="8" y1="4" x2="13.5" y2="11.5" />
      <line x1="2.5" y1="13" x2="13.5" y2="13" />
    </svg>
  ),
}

const FALLBACK_SVG = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M6 6.5a2 2 0 1 1 2 2v1" />
    <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
  </svg>
)

export function AgentIcon({ icon, size = 14 }: { icon: AgentIconId; size?: number }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {ICON_SVG[icon] ?? FALLBACK_SVG}
    </span>
  )
}
