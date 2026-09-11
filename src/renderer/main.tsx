import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useProjectStore } from './store/useProjectStore';
import './index.css';

// For the interface tests, which check what an interaction did to the project
// (how many clips, where a cut landed) rather than guessing from pixels. The
// page already owns this state; naming it adds no access.
(window as { __scfStore?: typeof useProjectStore }).__scfStore = useProjectStore;

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
