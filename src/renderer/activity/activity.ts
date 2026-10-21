import { create } from 'zustand';

/**
 * Work going on in the background that the window should show it is doing -
 * an import, so far. The thin bar along the top of the editor
 * (components/Layout/ActivityBar) reads this, the media store's analyses
 * and the captions job, and is there while any of them runs.
 */
interface ActivityState {
  tasks: Record<string, true>;
  begin(key: string): void;
  end(key: string): void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  tasks: {},
  begin(key) {
    if (get().tasks[key]) return;
    set({ tasks: { ...get().tasks, [key]: true } });
  },
  end(key) {
    if (!get().tasks[key]) return;
    const { [key]: _done, ...rest } = get().tasks;
    void _done;
    set({ tasks: rest });
  },
}));

/** Run `work` with `key` showing as going on until it settles. */
export async function withActivity<T>(key: string, work: () => Promise<T>): Promise<T> {
  useActivityStore.getState().begin(key);
  try {
    return await work();
  } finally {
    useActivityStore.getState().end(key);
  }
}
