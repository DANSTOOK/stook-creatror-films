import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AudioStream } from './audio/AudioStream';
import { renderTimelineAudio, streamTimelineAudio } from './audio/renderMix';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import { getActiveFrameRenderer } from './engine/FrameRenderer';
import './index.css';

// For the interface tests, which check what an interaction did to the project
// (how many clips, where a cut landed) rather than guessing from pixels. The
// page already owns this state; naming it adds no access.
(window as { __scfStore?: typeof useProjectStore }).__scfStore = useProjectStore;
// The stress test storms undo and redo and has to stop exactly where it began,
// which only the history itself can say.
(window as { __scfHistory?: typeof useHistoryStore }).__scfHistory = useHistoryStore;

// Which file the preview is drawing from: with proxies on it is the small
// stand-in, and the interface tests check exactly that - and that an export
// still reads the original.
(window as { __scfRenderer?: typeof getActiveFrameRenderer }).__scfRenderer = getActiveFrameRenderer;

// Streamed audio can only be checked in a real page - WebCodecs does not
// exist under the unit tests - so the harness that compares it against a full
// decode reaches it here.
(window as { __scfAudioStream?: typeof AudioStream }).__scfAudioStream = AudioStream;

// The streamed export mix is checked against the single render in a real
// page, for the same reason.
(window as { __scfMix?: object }).__scfMix = { renderTimelineAudio, streamTimelineAudio };

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
