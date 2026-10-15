import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The LUTs this machine has to hand.
 *
 * A look is applied across a whole sequence, and finding the same .cube file
 * through the dialog for every shot is the work this list exists to remove.
 * It is a setting of the machine, not of the project, so it lives in
 * localStorage - and it has to survive whatever is in there, including a
 * version of itself written by another build.
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

const KEY = 'scf.lutLibrary';

/** A fresh module, so it reads whatever the storage holds right now. */
async function loadStore() {
  vi.resetModules();
  const module = await import('@renderer/store/useLutLibrary');
  return module;
}

beforeEach(() => {
  storage.clear();
});

describe('keeping a look', () => {
  it('starts empty', async () => {
    const { useLutLibrary } = await loadStore();
    expect(useLutLibrary.getState().luts).toEqual([]);
  });

  it('keeps the file, and takes the name from the path when none is given', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('C:\\Looks\\Teal orange.cube');
    expect(useLutLibrary.getState().luts).toMatchObject([{ path: 'C:\\Looks\\Teal orange.cube', name: 'Teal orange.cube' }]);
  });

  it('writes it where the next session will find it', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('C:\\Looks\\a.cube', 'a.cube');
    expect(JSON.parse(storage.getItem(KEY) ?? '[]')).toMatchObject([{ path: 'C:\\Looks\\a.cube' }]);

    const again = await loadStore();
    expect(again.useLutLibrary.getState().luts).toMatchObject([{ name: 'a.cube' }]);
  });

  it('lists the most recently used first', async () => {
    const { useLutLibrary } = await loadStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
      useLutLibrary.getState().remember('/looks/first.cube');
      vi.setSystemTime(new Date('2026-10-15T11:00:00Z'));
      useLutLibrary.getState().remember('/looks/second.cube');
      expect(useLutLibrary.getState().luts.map((lut) => lut.name)).toEqual(['second.cube', 'first.cube']);

      // Using the older one again moves it back to the top.
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
      useLutLibrary.getState().remember('/looks/first.cube');
      expect(useLutLibrary.getState().luts.map((lut) => lut.name)).toEqual(['first.cube', 'second.cube']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists one file once, however it is spelled', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('C:\\Looks\\Film.cube');
    // The same file as Windows and as a URL would write it.
    useLutLibrary.getState().remember('c:/looks/film.cube');
    expect(useLutLibrary.getState().luts).toHaveLength(1);
  });

  it('stops growing, keeping what was used most recently', async () => {
    const { useLutLibrary, LIBRARY_LIMIT } = await loadStore();
    for (let index = 0; index < LIBRARY_LIMIT + 10; index++) {
      useLutLibrary.getState().remember(`/looks/${String(index).padStart(3, '0')}.cube`);
    }
    const luts = useLutLibrary.getState().luts;
    expect(luts).toHaveLength(LIBRARY_LIMIT);
    expect(luts.some((lut) => lut.name === '000.cube')).toBe(false);
    expect(luts.some((lut) => lut.name === `${String(LIBRARY_LIMIT + 9).padStart(3, '0')}.cube`)).toBe(true);
  });

  it('ignores a path that is no path at all', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('');
    expect(useLutLibrary.getState().luts).toEqual([]);
  });
});

describe('taking one off the list', () => {
  it('forgets it, and remembers that it did', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('/looks/a.cube');
    useLutLibrary.getState().remember('/looks/b.cube');
    useLutLibrary.getState().forget('/looks/a.cube');
    expect(useLutLibrary.getState().luts.map((lut) => lut.name)).toEqual(['b.cube']);
    expect(JSON.parse(storage.getItem(KEY) ?? '[]')).toHaveLength(1);
  });

  it('matches the way Windows spells the same file', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('C:\\Looks\\Film.cube');
    useLutLibrary.getState().forget('c:/looks/film.cube');
    expect(useLutLibrary.getState().luts).toEqual([]);
  });

  it('clears the lot', async () => {
    const { useLutLibrary } = await loadStore();
    useLutLibrary.getState().remember('/looks/a.cube');
    useLutLibrary.getState().clear();
    expect(useLutLibrary.getState().luts).toEqual([]);
  });
});

describe('whatever is in the storage', () => {
  it('opens empty rather than broken', async () => {
    for (const stored of ['not json', '{}', '"a string"', '[1, 2, 3]', 'null']) {
      storage.setItem(KEY, stored);
      const { useLutLibrary } = await loadStore();
      expect(useLutLibrary.getState().luts, stored).toEqual([]);
    }
  });

  it('keeps the entries it understands and drops the rest', async () => {
    storage.setItem(
      KEY,
      JSON.stringify([
        { path: '/looks/good.cube', name: 'good.cube', used: '2026-10-15T10:00:00.000Z' },
        { name: 'no path.cube' },
        { path: '' },
        42,
        null,
      ]),
    );
    const { useLutLibrary } = await loadStore();
    expect(useLutLibrary.getState().luts).toMatchObject([{ name: 'good.cube' }]);
  });

  it('fills in a missing name and a missing time', async () => {
    storage.setItem(KEY, JSON.stringify([{ path: 'C:\\Looks\\Kodak 2383.cube' }]));
    const { useLutLibrary } = await loadStore();
    expect(useLutLibrary.getState().luts[0]).toMatchObject({ name: 'Kodak 2383.cube' });
    expect(typeof useLutLibrary.getState().luts[0].used).toBe('string');
  });

  it('lists a file written twice only once', async () => {
    storage.setItem(
      KEY,
      JSON.stringify([
        { path: '/looks/a.cube', name: 'a.cube', used: '2026-10-15T10:00:00.000Z' },
        { path: '/LOOKS/A.cube', name: 'A.cube', used: '2026-10-15T11:00:00.000Z' },
      ]),
    );
    const { useLutLibrary } = await loadStore();
    expect(useLutLibrary.getState().luts).toHaveLength(1);
  });

  it('survives a storage that refuses to write', async () => {
    const { useLutLibrary } = await loadStore();
    const original = storage.setItem;
    storage.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(() => useLutLibrary.getState().remember('/looks/a.cube')).not.toThrow();
      // The list still works for this session; only tomorrow is lost.
      expect(useLutLibrary.getState().luts).toHaveLength(1);
    } finally {
      storage.setItem = original;
    }
  });
});
