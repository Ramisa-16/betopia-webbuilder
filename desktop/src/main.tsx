import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initTheme } from './lib/themes'

initTheme()

// Disable browser devtools context menu globally
document.addEventListener('contextmenu', e => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
