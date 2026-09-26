import { create } from 'zustand';
import type { MediaAsset } from '@shared/types';
import { notify } from '@renderer/notifications/notifications';
import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { errorText } from '@renderer/errorText';
import { classifyFile, hasNativeBridge } from './importMedia';

/**
 * Relinking: pointing a clip whose file went missing at where the file is now.
 *
 * The way Premiere's Link Media and Resolve's Relink work: choose the file
 * for one clip, and if other missing files are in the folder it came from -
 * a whole shoot moved to another drive, say - offer to relink them all at
 * once. The file picker is the main process's (the chosen path joins the
 * allowlist the same way an import does), and a clip keeps its URL, so the
 * timeline, the undo history and every other clip on the same file follow
 * without being rewritten.
 */

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const folderOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 ? path.slice(0, cut) : path;
};

export type RelinkAnswer = 'all' | 'one';

interface RelinkPromptState {
  prompt: { folder: string; names: string[]; resolve(answer: RelinkAnswer): void } | null;
  ask(folder: string, names: string[]): Promise<RelinkAnswer>;
  answer(answer: RelinkAnswer): void;
}

/** "Relink the others too?" - answered in RelinkDialog. */
export const useRelinkPrompt = create<RelinkPromptState>((set, get) => ({
  prompt: null,
  ask(folder, names) {
    return new Promise<RelinkAnswer>((resolve) => set({ prompt: { folder, names, resolve } }));
  },
  answer(answer) {
    const prompt = get().prompt;
    set({ prompt: null });
    prompt?.resolve(answer);
  },
}));

export const canRelink = (): boolean => hasNativeBridge() && typeof window.filmora.relinkPick === 'function';

/** Relink one missing asset, and offer the others found beside it. Resolves to how many were relinked. */
export async function relinkMissing(asset: MediaAsset): Promise<number> {
  if (!canRelink()) return 0;
  const bridge = window.filmora;
  const path = await bridge.relinkPick?.(asset.name, asset.sourcePath, asset.kind);
  if (!path) return 0;

  if (classifyFile(fileName(path)) !== asset.kind) {
    notify(t('notify.relinkWrongKind', { name: fileName(path), kind: t(`kind.${asset.kind}` as 'kind.video') }), 'error');
    return 0;
  }

  const targets: Array<{ asset: MediaAsset; path: string }> = [{ asset, path }];

  // The other missing files, looked for by name in the folder this one was in.
  const others = useProjectStore
    .getState()
    .assets.filter((other) => other.missing && other.id !== asset.id);
  if (others.length > 0 && bridge.relinkFind) {
    const wanted = new Map<string, MediaAsset>();
    for (const other of others) {
      const name = fileName(other.sourcePath ?? other.name);
      if (!wanted.has(name)) wanted.set(name, other);
    }
    const found = await bridge.relinkFind(folderOf(path), [...wanted.keys()]).catch(() => []);
    const matches = found
      .map((entry) => ({ asset: wanted.get(entry.name), path: entry.path }))
      .filter((entry): entry is { asset: MediaAsset; path: string } => entry.asset !== undefined && classifyFile(entry.path) === entry.asset.kind);
    if (matches.length > 0) {
      const answer = await useRelinkPrompt.getState().ask(folderOf(path), matches.map((entry) => fileName(entry.path)));
      if (answer === 'all') targets.push(...matches);
    }
  }

  const changes: Array<{ assetId: string; sourcePath: string; uri: string; audioUri?: string }> = [];
  for (const target of targets) {
    try {
      const uri = (await bridge.relinkApply?.(target.asset.uri, target.path)) ?? (await bridge.mediaUrl(target.path));
      const audioUri = target.asset.kind === 'image' ? null : await bridge.extractAudio(target.path).catch(() => null);
      changes.push({ assetId: target.asset.id, sourcePath: target.path, uri, ...(audioUri ? { audioUri } : {}) });
    } catch (error) {
      notify(t('notify.relinkFailed', { name: target.asset.name, detail: errorText(error) }), 'error');
    }
  }
  if (changes.length === 0) return 0;

  useProjectStore.getState().relinkAssets(changes);
  notify(
    changes.length === 1 ? t('notify.relinked', { name: fileName(changes[0].sourcePath) }) : t('notify.relinkedMany', { count: changes.length }),
    'success',
  );
  return changes.length;
}

/** The first missing asset, for "Relink…" on the toast a project opens with. */
export function relinkFirstMissing(): void {
  const first = useProjectStore.getState().assets.find((asset) => asset.missing);
  if (first) void relinkMissing(first);
}
