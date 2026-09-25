/**
 * English, the default and the fallback.
 *
 * Keys are grouped by area. A new string goes here first; `es.ts` is typed
 * against this object, so the Spanish dictionary cannot fall out of step
 * without the typecheck saying so.
 */
export const en = {
  /* Native application menu ---------------------------------------------- */
  'menu.file': '&File',
  'menu.edit': '&Edit',
  'menu.view': '&View',
  'menu.window': '&Window',
  'menu.help': '&Help',
  'menu.new': 'New project',
  'menu.open': 'Open project…',
  'menu.save': 'Save',
  'menu.saveAs': 'Save as…',
  'menu.import': 'Import media…',
  'menu.export': 'Export…',
  'menu.projectSettings': 'Project settings…',
  'menu.home': 'Start screen',
  'menu.exit': 'Exit',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.showMedia': 'Media',
  'menu.showInspector': 'Inspector',
  'menu.fullscreenViewer': 'Full-screen viewer',
  'menu.resetLayout': 'Reset layout',
  'menu.devTools': 'Developer tools',
  'menu.mixer': 'Mixer',
  'menu.minimize': 'Minimize',
  'menu.close': 'Close',
  'menu.shortcuts': 'Keyboard shortcuts',
  'menu.about': 'About {app}',
  'menu.aboutDetail': 'Version {version}',
};

export type Messages = typeof en;
