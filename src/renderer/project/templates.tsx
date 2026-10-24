import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { LayoutTemplate, Trash2 } from 'lucide-react';
import type { ProjectTemplate } from '@shared/types/ipc';
import type { ProjectDocument } from '@renderer/store/types';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT, t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { currentMarker, useSessionStore } from '@renderer/store/useSessionStore';
import { notify } from '@renderer/notifications/notifications';
import { errorText } from '@renderer/errorText';
import { rehydrateDocument } from '@renderer/media/importMedia';

/**
 * The user's own project templates: a project kept to start others from -
 * an intro, a lower third, the channel's music, the grade - as the
 * templates in Premiere's and CapCut's start screens, but one's own. Saved
 * from File > Save as template, shown on the start screen under My
 * templates; opening one is a new, untitled project with its contents.
 */

export const useSaveTemplate = create<{ open: boolean; show(): void; close(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export async function saveAsTemplate(name: string): Promise<boolean> {
  try {
    const json = JSON.stringify(useProjectStore.getState().toDocument());
    await window.filmora.templateSave(name, json);
    notify(t('template.saved', { name }), 'success');
    return true;
  } catch (error) {
    notify(t('template.failed', { detail: errorText(error) }), 'error');
    return false;
  }
}

/** A new, untitled project with a template's contents, its media re-read from disk. */
export async function openTemplate(template: ProjectTemplate): Promise<boolean> {
  try {
    const document = JSON.parse(await window.filmora.templateRead(template.id)) as ProjectDocument;
    const { assets, project } = await rehydrateDocument(document.assets ?? [], document.project);
    useProjectStore.getState().loadDocument({ ...document, assets, project });
    useSessionStore.getState().startProject(null, t('home.untitled'), currentMarker());
    notify(t('template.opened', { name: template.name }), 'success');
    return true;
  } catch (error) {
    notify(t('template.openFailed', { detail: errorText(error) }), 'error');
    return false;
  }
}

export function SaveTemplateDialog(): JSX.Element | null {
  const tr = useT();
  const open = useSaveTemplate((state) => state.open);
  const close = useSaveTemplate((state) => state.close);
  const projectName = useSessionStore((state) => state.projectName);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setName(projectName || tr('home.untitled'));
  }, [open, projectName, tr]);
  if (!open) return null;
  return (
    <Dialog title={tr('template.title')} icon={LayoutTemplate} onClose={close} testId="template-dialog">
      <div className="space-y-3 p-4">
        <label className="block space-y-1">
          <span className="field-label">{tr('template.name')}</span>
          <input
            data-testid="template-name"
            className="input-field h-control w-full px-2 text-sm"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim()) document.querySelector<HTMLButtonElement>('[data-testid="template-save"]')?.click();
            }}
          />
        </label>
        <p className="text-2xs leading-relaxed text-slate-400">{tr('template.hint')}</p>
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="template-save"
            className="button-primary h-control px-4"
            disabled={!name.trim() || saving}
            onClick={() => {
              setSaving(true);
              void saveAsTemplate(name.trim()).then((done) => {
                setSaving(false);
                if (done) close();
              });
            }}
          >
            {tr('template.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The start screen's My templates: each opens a new project from it. */
export function MyTemplates({ onOpen }: { onOpen(template: ProjectTemplate): void }): JSX.Element | null {
  const tr = useT();
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const refresh = (): void => {
    void window.filmora?.templatesList?.().then(setTemplates).catch(() => setTemplates([]));
  };
  useEffect(refresh, []);
  if (templates.length === 0) return null;
  return (
    <div className="scf-rise space-y-1.5" data-testid="home-templates">
      <h3 className="section-title px-0.5">{tr('template.mine')}</h3>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {templates.map((template) => (
          <li key={template.id} className="group flex items-center gap-2 rounded-control bg-panel-900 pr-1 ring-1 ring-panel-700 hover:ring-panel-600">
            <button type="button" data-testid={`home-template-${template.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left" onClick={() => onOpen(template)}>
              <LayoutTemplate size={14} aria-hidden className="shrink-0 text-accent-hover" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-slate-100">{template.name}</span>
                <span className="block text-2xs text-slate-400">
                  {template.width}×{template.height} · {tr('template.clips', { count: template.clips })}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="tool-button tool-button-dense w-6 px-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={tr('template.delete')}
              onClick={() => void window.filmora.templateDelete(template.id).then(refresh)}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
