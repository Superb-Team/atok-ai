import React from 'react'
import ReactDOM from 'react-dom/client'
import RecordingPopupApp from '@/features/recording/components/RecordingPopupApp'
import '@/styles/globals.css'

ReactDOM.createRoot(document.getElementById('recording-popup-root')!).render(
  <React.StrictMode>
    <RecordingPopupApp />
  </React.StrictMode>,
)