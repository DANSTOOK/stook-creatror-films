import { app, type BrowserWindow } from 'electron';

/**
 * Background mode, for automated runs: SCF_BACKGROUND=1.
 *
 * The test harnesses drive the real app on the same PC somebody may be using
 * - watching a video, typing elsewhere - and every window they opened popped
 * up in front and took the focus. In this mode the window exists and renders
 * exactly as usual, but where nobody sees it: shown without activation,
 * parked off-screen, left out of the taskbar, and never focused, restored or
 * raised. A normal launch is untouched.
 *
 * Off-screen is not the same as hidden. A hidden window stops painting, and
 * Chromium also counts a window covered or off every display as occluded and
 * slows it down to about one frame a second; the preview, the scrub checks and
 * the frame-cadence test all need it painting at the display's rate. So the
 * window is shown (inactive), background throttling is off, and the occlusion
 * calculation that would demote it is disabled.
 */
export const BACKGROUND = process.env.SCF_BACKGROUND === '1';

/** Far past any display, the way Windows itself parks minimised windows. */
export const OFF_SCREEN = -32000;

/**
 * Chromium switches for background mode. Before `ready`: switches appended
 * later are ignored. `disable-features` is merged with any value already set,
 * because a second switch of the same name replaces the first.
 */
export function applyBackgroundSwitches(): void {
  if (!BACKGROUND) return;
  const existing = app.commandLine.getSwitchValue('disable-features');
  const features = [...existing.split(',').filter(Boolean), 'CalculateNativeWinOcclusion'];
  app.commandLine.appendSwitch('disable-features', [...new Set(features)].join(','));
}

/**
 * Keep a background window off-screen for good: tests resize it, centre it and
 * set its bounds, and each of those would bring it back onto a display. The
 * size they ask for is kept; only the position is put back.
 */
export function keepOffScreen(window: BrowserWindow): void {
  if (!BACKGROUND) return;
  const park = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMaximized() || window.isFullScreen()) {
      window.setFullScreen(false);
      window.unmaximize();
    }
    const [x, y] = window.getPosition();
    if (x !== OFF_SCREEN || y !== OFF_SCREEN) window.setPosition(OFF_SCREEN, OFF_SCREEN, false);
  };
  window.on('move', park);
  window.on('resize', park);
  window.on('maximize', park);
  window.on('enter-full-screen', park);
  park();
}
