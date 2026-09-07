import { BrowserRouter, Route, Routes } from 'react-router-dom'
import MainPage from './pages/MainPage/MainPage'

export default function RootRouter() {
  return <BrowserRouter><Routes><Route path="/" element={<MainPage />} /></Routes></BrowserRouter>
}
