import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootRouter from './RootRouter.jsx'

function applyTheme() {
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    document.documentElement.dataset.theme = "dark"
  } 
  
  else {
    delete document.documentElement.dataset.theme
  }
}

applyTheme()

createRoot(document.getElementById('root')).render(<RootRouter />)