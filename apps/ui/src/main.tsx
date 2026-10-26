import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.js';
import 'reactflow/dist/style.css';
import './styles/theme.css';
import './styles/theme.part2.css';
import './styles/workflow.css';
import { fitZoom } from './ui/fitZoom.js';

// Below 1920px wide, scale the whole UI down so a laptop sees the 1080p layout.
const applyFitZoom = () => document.documentElement.style.setProperty('--fit-zoom', String(fitZoom(window.innerWidth)));
applyFitZoom();
window.addEventListener('resize', applyFitZoom);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
