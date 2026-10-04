import type { PlanData } from '@/types'

const CHECK_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const SPIN_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="plan-step-spin">
    <path d="M21 12a9 9 0 1 1-6.22-8.56" />
  </svg>
)

const PENDING_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
  </svg>
)

interface Props {
  data: PlanData
}

export default function PlanPanel({ data }: Props) {
  const steps = data.steps ?? []
  const total = steps.length
  const done = steps.filter(step => step.status === 'completed').length
  const allDone = total > 0 && done === total

  if (total === 0 && !data.explanation?.trim()) return null

  if (allDone) {
    return (
      <div className="plan-panel-layer">
        <div className="plan-panel plan-panel--complete" aria-label="Completed plan">
          <div className="plan-panel-summary">
            <span className="plan-panel-summary-left">
              <span className="plan-panel-summary-dot" aria-hidden="true" />
              <span className="plan-panel-title">Plan</span>
            </span>
            <span className="plan-panel-summary-right">
              <span className="plan-panel-count">{done}/{total}</span>
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="plan-panel-layer">
      <details className="plan-panel" open>
        <summary className="plan-panel-summary">
          <span className="plan-panel-summary-left">
            <span className="plan-panel-summary-dot" aria-hidden="true" />
            <span className="plan-panel-title">Plan</span>
          </span>
          <span className="plan-panel-summary-right">
            <span className="plan-panel-count">{done}/{total}</span>
            <span className="plan-panel-chevron" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </span>
        </summary>

        <div className="plan-panel-body">
          {data.explanation?.trim() && (
            <div className="plan-panel-explanation">
              {data.explanation}
            </div>
          )}
          {steps.map((step, index) => {
            const icon = step.status === 'completed'
              ? CHECK_ICON
              : step.status === 'in_progress'
                ? SPIN_ICON
                : PENDING_ICON
            return (
              <div key={`${index}-${step.step}`} className={`plan-step ${step.status}`}>
                <span className="plan-step-icon" aria-hidden="true">
                  {icon}
                </span>
                <span className="plan-step-text">{step.step}</span>
              </div>
            )
          })}
        </div>
      </details>
    </div>
  )
}
