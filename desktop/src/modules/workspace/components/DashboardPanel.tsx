/**
 * DashboardPanel.tsx - Analytics dashboard panel (Manus-style)
 */
import { useState } from 'react'

interface Props {
  onAskAI?: (msg: string) => void
  projectName?: string
  publishedUrl?: string | null
  isPublished?: boolean
  onMakeCopy?: () => void
}

export default function DashboardPanel({ projectName = 'My Project', publishedUrl, isPublished }: Props) {
  const [timeFilter, setTimeFilter] = useState('Last 24 hours')

  const timeOptions = ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days']

  return (
    <div className="dashboard-panel">
      {/* Dashboard header */}
      <div className="dashboard-header">
        <div className="dashboard-header-left">
          <div className="dashboard-project-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          </div>
          <div>
            <h2 className="dashboard-project-name">{projectName}</h2>
            <div className="dashboard-project-links">
              <a href="#" className="dashboard-link">Documentation</a>
              <span className="dashboard-link-sep">&#183;</span>
              {publishedUrl ? (
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="dashboard-link">
                  Open website
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginLeft: 3}}>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </a>
              ) : (
                <span className="dashboard-link dashboard-link-disabled">Open website</span>
              )}
            </div>
          </div>
        </div>
        <div className="dashboard-header-right">
          <span className={'dashboard-status-badge' + (isPublished ? ' published' : '')}>
            <span className="dashboard-status-dot" />
            {isPublished ? 'Public' : 'Not published'}
          </span>
          <button className="dashboard-manage-btn">Manage access</button>
        </div>
      </div>

      {/* Analytics section */}
      <div className="dashboard-analytics">
        <div className="dashboard-analytics-header">
          <h3 className="dashboard-section-title">Analytics</h3>
          <div className="dashboard-filters">
            <div className="dashboard-time-select">
              <select
                value={timeFilter}
                onChange={e => setTimeFilter(e.target.value)}
                className="dashboard-select"
              >
                {timeOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <button className="dashboard-filter-btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              Filters
            </button>
            <button className="dashboard-filter-btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7"/>
                <path d="M3 3v6h6"/>
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="dashboard-stats-row">
          {[
            { label: 'PAGE VIEWS', value: '2,847', change: '+12%', up: true },
            { label: 'VISITS', value: '1,203', change: '+8%', up: true },
            { label: 'VISITORS', value: '986', change: '+5%', up: true },
            { label: 'DURATION', value: '2m 14s', change: '-3%', up: false },
            { label: 'BOUNCE RATE', value: '42.1%', change: '-2%', up: true },
          ].map(stat => (
            <div key={stat.label} className="dashboard-stat-card">
              <span className="dashboard-stat-label">{stat.label}</span>
              <span className="dashboard-stat-value">{stat.value}</span>
              <span className={'dashboard-stat-change' + (stat.up ? ' up' : ' down')}>{stat.change}</span>
            </div>
          ))}
        </div>

        {/* Line chart */}
        <div className="dashboard-chart-wrap">
          <svg viewBox="0 0 800 160" xmlns="http://www.w3.org/2000/svg" className="dashboard-chart-svg" preserveAspectRatio="none">
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25"/>
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
              </linearGradient>
            </defs>
            {/* Grid lines */}
            {[40, 80, 120].map(y => (
              <line key={y} x1="0" y1={y} x2="800" y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
            ))}
            {/* Fill */}
            <path
              d="M0,140 C40,120 80,100 120,90 C160,80 200,75 240,70 C280,65 320,60 360,55 C400,50 440,45 480,50 C520,55 560,60 600,50 C640,40 680,30 720,25 C760,20 800,22 800,22 L800,160 L0,160 Z"
              fill="url(#chartGrad)"
            />
            {/* Line */}
            <path
              d="M0,140 C40,120 80,100 120,90 C160,80 200,75 240,70 C280,65 320,60 360,55 C400,50 440,45 480,50 C520,55 560,60 600,50 C640,40 680,30 720,25 C760,20 800,22 800,22"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* Data points */}
            {[[0,140],[120,90],[240,70],[360,55],[480,50],[600,50],[720,25],[800,22]].map(([x,y], i) => (
              <circle key={i} cx={x} cy={y} r="3" fill="var(--accent)" />
            ))}
            {/* X-axis labels */}
            {['00:00','03:00','06:00','09:00','12:00','15:00','18:00','21:00'].map((t, i) => (
              <text key={t} x={i * 800/7} y="155" fontSize="9" fill="var(--text-3)" fontFamily="var(--font)">{t}</text>
            ))}
          </svg>
        </div>
      </div>

      {/* Bottom tables */}
      <div className="dashboard-tables-row">
        <div className="dashboard-table-card">
          <div className="dashboard-table-header">
            <span className="dashboard-table-title">Most viewed pages</span>
            <span className="dashboard-table-col-header">Views</span>
          </div>
          <div className="dashboard-table-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity: 0.3, marginBottom: 6}}>
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span>No page data yet</span>
          </div>
        </div>

        <div className="dashboard-table-card">
          <div className="dashboard-table-header">
            <span className="dashboard-table-title">Referrers</span>
            <span className="dashboard-table-col-header">Visitors</span>
          </div>
          <div className="dashboard-table-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity: 0.3, marginBottom: 6}}>
              <circle cx="18" cy="5" r="3"/>
              <circle cx="6" cy="12" r="3"/>
              <circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            <span>No referrer data yet</span>
          </div>
        </div>
      </div>
    </div>
  )
}
