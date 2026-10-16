import { Headphones, Images, MonitorPlay, Rows3, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '@renderer/i18n';
import type { DetachablePanel } from '@renderer/store/useWorkspaceStore';

/**
 * What each panel is called, and the picture that stands for it, wherever a
 * panel is named outside itself: its window's bar and title, and the title
 * bar's list of panels that are out in windows of their own.
 *
 * The icons show what a panel holds rather than where it sits. The title
 * bar's show/hide buttons draw a position (left, bottom, right), which says
 * nothing once the panel is on another screen.
 */

export const PANEL_NAME: Record<DetachablePanel, MessageKey> = {
  viewer: 'panel.viewer',
  timeline: 'titlebar.timeline',
  media: 'titlebar.media',
  inspector: 'titlebar.inspector',
  mixer: 'mixer.title',
};

export const PANEL_ICON: Record<DetachablePanel, LucideIcon> = {
  viewer: MonitorPlay,
  timeline: Rows3,
  media: Images,
  inspector: SlidersHorizontal,
  mixer: Headphones,
};
