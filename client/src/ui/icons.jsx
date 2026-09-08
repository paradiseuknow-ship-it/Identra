import React from 'react';

// 极简 16px stroke 图标集（自绘，无第三方依赖）。所有图标继承 currentColor。
function S({ children, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconOverview = () => (<S><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></S>);
export const IconTasks = () => (<S><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 5-5.5" /></S>);
export const IconRuns = () => (<S><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5.5 3.5-5.5 3.5z" /></S>);
export const IconWindow = () => (<S><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M3 9.5h18" /><path d="M6.2 7h.01" /><path d="M9 7h.01" /></S>);
export const IconAI = () => (<S><path d="M12 3.5 13.7 9a2 2 0 0 0 1.3 1.3l5.5 1.7-5.5 1.7a2 2 0 0 0-1.3 1.3L12 20.5 10.3 15a2 2 0 0 0-1.3-1.3L3.5 12 9 10.3A2 2 0 0 0 10.3 9z" /></S>);
export const IconClock = () => (<S><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></S>);
export const IconLayers = () => (<S><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12.5 9 4.5 9-4.5" /><path d="m3 17 9 4.5 9-4.5" /></S>);
export const IconPulse = () => (<S><path d="M22 12h-4l-3 8-6-16-3 8H2" /></S>);
export const IconMemory = () => (<S><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5V18.5c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></S>);
export const IconGlobe = () => (<S><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13.5 13.5 0 0 1 3.5 9 13.5 13.5 0 0 1-3.5 9 13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3z" /></S>);
export const IconShield = () => (<S><path d="M12 21.5s7.5-3.5 7.5-9.5V5.5L12 2.8 4.5 5.5V12c0 6 7.5 9.5 7.5 9.5z" /></S>);
export const IconSettings = () => (<S><path d="M5 21v-6M5 11V3M12 21v-9M12 8V3M19 21v-4M19 13V3" /><path d="M2.5 15h5M9.5 8h5M16.5 17h5" /></S>);
export const IconPlus = () => (<S><path d="M12 5v14M5 12h14" /></S>);
export const IconChevron = ({ open }) => (<S><path d="m9 6 6 6-6 6" style={{ transform: open ? 'rotate(90deg)' : 'none', transformOrigin: 'center' }} /></S>);
export const IconExternal = () => (<S><path d="M15 4h5v5" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></S>);
export const IconLogo = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#171A22" stroke="#2A2E3A" />
    <path d="M12 6.2 13.4 10a2 2 0 0 0 1.16 1.16L18.4 12.5l-3.84 1.34A2 2 0 0 0 13.4 15L12 18.8 10.6 15a2 2 0 0 0-1.16-1.16L5.6 12.5l3.84-1.34A2 2 0 0 0 10.6 10z" fill="#4D7CF6" />
  </svg>
);
