import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootRouter from './RootRouter'

function applyTheme(): void {
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Не найден элемент #root')
createRoot(root).render(<StrictMode><RootRouter /></StrictMode>)
