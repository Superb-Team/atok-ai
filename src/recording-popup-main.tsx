import React from 'react'
import ReactDOM from 'react-dom/client'
import RecordingPopupApp from './components/RecordingPopupApp.tsx'
import './App.css'

ReactDOM.createRoot(document.getElementById('recording-popup-root')!).render(
  <React.StrictMode>
    <RecordingPopupApp />
  </React.StrictMode>,
)