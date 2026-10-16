import type { HTMLAttributes, ReactNode } from 'react';
import { icon } from '../components/icons';

export function SetupScreen({
  children,
  events,
}: {
  children: ReactNode;
  events: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div className="setup-screen" {...events}>
      <header className="app-titlebar setup-titlebar">
        <span className="chrome-brand">
          <img src="./branding/icon.svg" alt="" width="24" height="24" /> Transcribe Studio
        </span>
        <div className="top-spacer" />
        <div className="window-controls">
          <button data-window="minimize" aria-label="最小化">
            {icon('minimize')}
          </button>
          <button data-window="maximize" aria-label="最大化">
            {icon('maximize')}
          </button>
          <button data-window="close" aria-label="關閉視窗">
            {icon('x')}
          </button>
        </div>
      </header>
      <main className="setup-screen-body">{children}</main>
    </div>
  );
}
