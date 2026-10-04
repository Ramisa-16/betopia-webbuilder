import ReactDOM from 'react-dom/client'
import React from 'react'
import App from './App'
import './index.css'
import { initTheme } from './lib/themes'

initTheme()

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[App crash]', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', background: '#1a1a1a', color: '#ff6b6b', minHeight: '100vh' }}>
          <h2 style={{ color: '#ff6b6b', marginBottom: 16 }}>App crashed during render</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#ff9090', background: '#2a1a1a', padding: 16, borderRadius: 8 }}>
            {this.state.error.message}{'\n\n'}{this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
