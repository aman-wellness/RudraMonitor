/* Tab definitions live apart from the component so the module exports only
   components (react-refresh) — the page imports both. */
export const tabLabels = [
  { id: 'applications', label: 'Applications', icon: 'ri-apps-line' },
  { id: 'browser', label: 'Browser', icon: 'ri-global-line' },
  { id: 'live', label: 'Live', icon: 'ri-broadcast-line' },
  { id: 'remote', label: 'Remote', icon: 'ri-remote-control-2-line' },
  { id: 'videos', label: 'Videos', icon: 'ri-video-line' },
  { id: 'screenshots', label: 'Screenshots', icon: 'ri-image-line' },
  { id: 'idle', label: 'Idle', icon: 'ri-timer-line' },
] as const;

export type TabId = (typeof tabLabels)[number]['id'];
