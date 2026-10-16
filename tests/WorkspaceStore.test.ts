import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which panels are open in a window of their own.
 *
 * It is a setting of the machine, not of the project, so it lives in
 * localStorage: somebody with two monitors wants the viewer to come back on
 * the second one tomorrow morning as well.
 */

class MemoryStorage {
  private readonly entries = new Map<string, string>();
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
}

const storage = new MemoryStorage();
vi.stubGlobal('window', { localStorage: storage });

/** A fresh module, so it reads whatever the storage holds right now. */
async function loadStore() {
  vi.resetModules();
  const module = await import('@renderer/store/useWorkspaceStore');
  return module.useWorkspaceStore;
}

beforeEach(() => {
  storage.clear();
});

describe('the workspace', () => {
  it('starts with every panel in the main window', async () => {
    const store = (await loadStore()).getState();
    expect(store.detached).toEqual({ viewer: false, media: false, inspector: false, mixer: false, timeline: false });
  });

  it('remembers a panel sent to its own window', async () => {
    (await loadStore()).getState().setDetached('viewer', true);

    const reopened = (await loadStore()).getState();
    expect(reopened.isDetached('viewer')).toBe(true);
    expect(reopened.isDetached('mixer')).toBe(false);
  });

  it('docks a panel again', async () => {
    const store = await loadStore();
    store.getState().setDetached('mixer', true);
    store.getState().toggleDetached('mixer');

    expect(store.getState().isDetached('mixer')).toBe(false);
    expect((await loadStore()).getState().isDetached('mixer')).toBe(false);
  });

  it('brings everything back in one go', async () => {
    const store = await loadStore();
    store.getState().setDetached('viewer', true);
    store.getState().setDetached('inspector', true);

    store.getState().dockAll();

    expect(store.getState().detached).toEqual({ viewer: false, media: false, inspector: false, mixer: false, timeline: false });
    expect((await loadStore()).getState().isDetached('viewer')).toBe(false);
  });

  it('ignores a stored value it cannot read, rather than starting broken', async () => {
    storage.setItem('scf.detachedPanels', 'not json');
    expect((await loadStore()).getState().detached.viewer).toBe(false);

    storage.setItem('scf.detachedPanels', '{"viewer":"yes","nonsense":true}');
    const store = (await loadStore()).getState();
    expect(store.detached.viewer).toBe(false);
    expect(Object.keys(store.detached).sort()).toEqual(['inspector', 'media', 'mixer', 'timeline', 'viewer']);
  });

  it('lets the timeline have a window of its own too', async () => {
    (await loadStore()).getState().setDetached('timeline', true);

    const reopened = (await loadStore()).getState();
    expect(reopened.isDetached('timeline')).toBe(true);
    expect(reopened.isDetached('viewer')).toBe(false);
  });

  it('reads a layout saved before the timeline could leave, with the timeline docked', async () => {
    // What a version that knew only four panels wrote.
    storage.setItem('scf.detachedPanels', '{"viewer":true,"media":false,"inspector":false,"mixer":true}');
    const store = (await loadStore()).getState();
    expect(store.detached).toEqual({ viewer: true, media: false, inspector: false, mixer: true, timeline: false });
  });
});
