import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.js';
import 'reactflow/dist/style.css';
import './styles/theme.css';
import './styles/theme.part2.css';
import './styles/workflow.css';
import { fitZoom } from './ui/fitZoom.js';
import { applyMotion, watchFrameDrops } from './ui/motion.js';

// Scale the whole UI so every desktop screen sees the 1080p layout (see fitZoom.ts).
const applyFitZoom = () => document.documentElement.style.setProperty('--fit-zoom', String(fitZoom(window.innerWidth, window.innerHeight)));
applyFitZoom();
window.addEventListener('resize', applyFitZoom);
applyMotion();
watchFrameDrops();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
