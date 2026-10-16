import type { HTMLAttributes, ReactNode } from 'react';
import { icon } from '../components/icons';
import { Button } from '../primitives/button';

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
          <Button variant="ghost" size="bare" data-window="minimize" aria-label="最小化">
            {icon('minimize')}
          </Button>
          <Button variant="ghost" size="bare" data-window="maximize" aria-label="最大化">
            {icon('maximize')}
          </Button>
          <Button variant="ghost" size="bare" data-window="close" aria-label="關閉視窗">
            {icon('x')}
          </Button>
        </div>
      </header>
      <main className="setup-screen-body">{children}</main>
    </div>
  );
}
