import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AudioStream } from './audio/AudioStream';
import { renderTimelineAudio, streamTimelineAudio } from './audio/renderMix';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import { useMediaStore } from './store/useMediaStore';
import { getAudioEngine } from './audio/AudioEngine';
import { getActiveFrameRenderer } from './engine/FrameRenderer';
import './index.css';
import { installMotionEnvironment } from './motion/environment';
import { ghostCount, prepareGhosts } from './motion/ghost';
import { zoomStats } from './components/Timeline/zoomMotion';
import { useCaptionJob } from './captions/captionJob';
import { useCaptionModels } from './captions/captionModels';
import { checkCue, isWeak, rulesFor } from './captions/rules';
import { captionCues } from './captions/captionClips';
import { captionWordLayout } from './captions/captionRender';
import { glossarySuggestions } from './captions/glossary';
import { parseSubtitles, writeSrt, writeVtt } from './captions/subtitleFiles';

// Reduced motion, playing and exporting, as attributes on <html> for the CSS
// to read - set before the first render so nothing animates it should not.
installMotionEnvironment();
prepareGhosts();
// The motion test counts exits still on screen.
(window as { __scfMotion?: object }).__scfMotion = { ghostCount, zoomStats };

// For the interface tests, which check what an interaction did to the project
// (how many clips, where a cut landed) rather than guessing from pixels. The
// page already owns this state; naming it adds no access.
(window as { __scfStore?: typeof useProjectStore }).__scfStore = useProjectStore;
// The stress test storms undo and redo and has to stop exactly where it began,
// which only the history itself can say.
(window as { __scfHistory?: typeof useHistoryStore }).__scfHistory = useHistoryStore;
// Waveforms and filmstrips arrive from the main process; the probes wait for them.
(window as { __scfMediaStore?: typeof useMediaStore }).__scfMediaStore = useMediaStore;
// The mixer's meters read the engine; the probes count how often, and when.
(window as { __scfAudioEngine?: typeof getAudioEngine }).__scfAudioEngine = getAudioEngine;

// Which file the preview is drawing from: with proxies on it is the small
// stand-in, and the interface tests check exactly that - and that an export
// still reads the original.
(window as { __scfRenderer?: typeof getActiveFrameRenderer }).__scfRenderer = getActiveFrameRenderer;

// Captions are checked against their own rules, and their job watched from
// outside: the tests ask the same code the app runs, not a copy of it.
(window as { __scfCaptions?: object }).__scfCaptions = {
  job: useCaptionJob,
  models: useCaptionModels,
  rulesFor,
  checkCue,
  isWeak,
  captionCues,
  writeSrt,
  writeVtt,
  parseSubtitles,
  // Where a moving caption's words are, and how they stand at a frame.
  wordLayout: (clipId: string, frame?: number) => captionWordLayout(useProjectStore.getState().project, clipId, frame),
  glossarySuggestions,
  // How many pictures of moving words have been drawn, for the cost of animated captions.
  wordsDrawn: () => getActiveFrameRenderer()?.titles.drawn ?? 0,
};

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
