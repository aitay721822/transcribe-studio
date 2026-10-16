import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  home: (
    <>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
    </>
  ),
  wave: (
    <>
      <path d="M3 10v4m4-7v10m5-15v20m5-16v12m4-8v4" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8m-8 4h5" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  sparkle: (
    <>
      <path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8zM20 2v4m-2-2h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="8" cy="7" r="3" />
      <circle cx="16" cy="17" r="3" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r=".8" />
      <circle cx="12" cy="12" r=".8" />
      <circle cx="19" cy="12" r=".8" />
    </>
  ),
  edit: (
    <>
      <path d="m14 5 5 5M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15zM12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="3" width="18" height="4" rx="1" />
      <path d="M4 7v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M9 11h6" />
    </>
  ),
  list: (
    <>
      <path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </>
  ),
  back: <path d="M19 12H5m5-5-5 5 5 5" />,
  down: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M12 16v5m-5 0h10" />
    </>
  ),
  headphones: (
    <>
      <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
      <rect x="3" y="12" width="4" height="8" rx="2" />
      <rect x="17" y="12" width="4" height="8" rx="2" />
    </>
  ),
  play: (
    <>
      <path d="m8 4 12 8-12 8z" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  stop: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M6 18 18 6" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
    </>
  ),
  history: (
    <>
      <path d="M3 10a9 9 0 1 1 1 7M3 4v6h6m3-3v5l3 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  book: (
    <>
      <path d="M12 5v16M3 3c4 0 7 0 9 2 2-2 5-2 9-2v16c-4 0-7 0-9 2-2-2-5-2-9-2z" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9L2 9zM11 13 22 2" />
    </>
  ),
  pin: (
    <>
      <path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  link: (
    <>
      <path d="m10 13 4-4m-5-1 3-3a4 4 0 0 1 6 6l-3 3m0 2-3 3a4 4 0 0 1-6-6l3-3" />
    </>
  ),
  minimize: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  maximize: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </>
  ),
};

export function icon(name: string, cls = '') {
  return (
    <svg
      className={`icon ${cls}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
}
