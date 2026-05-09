import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RootRouter from './RootRouter.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootRouter />
  </StrictMode>,
)
