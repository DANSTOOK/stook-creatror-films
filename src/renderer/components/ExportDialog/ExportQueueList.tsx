import { CircleCheck, CircleX, Clock, ListVideo, Loader2, Play, X } from 'lucide-react';
import { useT, type MessageKey } from '@renderer/i18n';
import { useExportQueue, type QueuedExport, type QueuedStatus } from '@renderer/export/queue';

/**
 * The render queue in the export dialog: what is waiting, what is
 * rendering, what came out - each with its size and format - and the one
 * button that renders the lot, one after another.
 */

const STATUS: Record<QueuedStatus, { label: MessageKey; className: string }> = {
  waiting: { label: 'queue.waiting', className: 'text-slate-300' },
  rendering: { label: 'queue.rendering', className: 'text-accent-hover' },
  done: { label: 'queue.finished', className: 'text-emerald-300' },
  failed: { label: 'queue.failed', className: 'text-red-300' },
  cancelled: { label: 'queue.cancelled', className: 'text-amber-300' },
};

function StatusIcon({ status }: { status: QueuedStatus }): JSX.Element {
  if (status === 'rendering') return <Loader2 size={13} className="animate-spin text-accent-hover" aria-hidden />;
  if (status === 'done') return <CircleCheck size={13} className="text-emerald-300" aria-hidden />;
  if (status === 'failed' || status === 'cancelled') return <CircleX size={13} className={STATUS[status].className} aria-hidden />;
  return <Clock size={13} className="text-slate-400" aria-hidden />;
}

export function ExportQueueList({ jobs, running, onRender }: { jobs: QueuedExport[]; running: boolean; onRender(): void }): JSX.Element {
  const t = useT();
  const waiting = jobs.filter((job) => job.status === 'waiting').length;
  const finished = jobs.some((job) => job.status !== 'waiting' && job.status !== 'rendering');
  return (
    <section className="mb-3 space-y-2 rounded-lg border border-panel-700 bg-panel-900/60 p-3" data-testid="export-queue">
      <div className="flex items-center gap-2">
        <ListVideo size={14} className="text-accent-hover" aria-hidden />
        <h3 className="text-xs font-semibold text-slate-100">{t('queue.title')}</h3>
        <span className="text-2xs text-slate-400">{t('queue.count', { count: jobs.length })}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {finished && !running && (
            <button type="button" className="tool-button tool-button-dense text-2xs" onClick={() => useExportQueue.getState().clearFinished()}>
              {t('queue.clear')}
            </button>
          )}
          <button
            type="button"
            data-testid="export-queue-run"
            className="button-primary h-7 px-3 text-xs"
            disabled={running || waiting === 0}
            onClick={onRender}
          >
            <Play size={12} aria-hidden />
            {t('queue.render', { count: waiting })}
          </button>
        </div>
      </div>
      <ul className="space-y-1">
        {jobs.map((job) => (
          <li
            key={job.id}
            data-testid="export-queue-job"
            data-status={job.status}
            className="flex items-center gap-2 rounded-control bg-panel-950 px-2 py-1.5 ring-1 ring-panel-700"
          >
            <StatusIcon status={job.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-slate-100">{job.name}</span>
              <span className="block text-2xs text-slate-400">
                {job.settings.width}×{job.settings.height} · {job.settings.fps || job.project.fps} fps ·{' '}
                {t('queue.length', { seconds: Math.round((job.settings.endFrame - job.settings.startFrame) / (job.settings.fps || job.project.fps)) })}
              </span>
            </span>
            <span className={`text-2xs ${STATUS[job.status].className}`}>{t(STATUS[job.status].label)}</span>
            {job.status !== 'rendering' && (
              <button
                type="button"
                className="tool-button tool-button-dense w-6 px-0"
                aria-label={t('queue.remove')}
                disabled={running && job.status === 'waiting'}
                onClick={() => useExportQueue.getState().remove(job.id)}
              >
                <X size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
