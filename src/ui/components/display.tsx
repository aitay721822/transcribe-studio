import type { ReactNode } from 'react';
import { Button } from '../primitives/button';
import { icon } from './icons';

export const statusLabel: Record<string, string> = {
  draft: '草稿',
  recording: '錄音中',
  transcribing: '辨識中',
  completed: '已完成',
  interrupted: '錄音中斷',
  failed: '辨識失敗',
};

export function date(value: string, full = false) {
  return new Date(value).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    ...(full
      ? {}
      : {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
  });
}

export function duration(seconds: number) {
  const s = Math.floor(seconds || 0);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function badge(status: string) {
  return (
    <span className={`badge ${status}`}>
      <i className="dot" />
      {statusLabel[status] || status}
    </span>
  );
}

export function btn(label: ReactNode, action: string, glyph = '', cls = '', iconOnly = false) {
  const buttonVariant = () => {
    if (cls.includes('primary')) {
      return 'default';
    }
    if (cls.includes('danger')) {
      return 'destructive';
    }
    if (cls.includes('text')) {
      return 'ghost';
    }
    return 'outline';
  };

  return (
    <Button
      className={`btn ${cls}`}
      variant={buttonVariant()}
      size={cls.includes('small') ? 'sm' : 'default'}
      data-action={action}
    >
      {glyph ? icon(glyph) : null}
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </Button>
  );
}

export function empty(title: ReactNode, description: ReactNode, action: ReactNode = null) {
  return (
    <div className="empty">
      <div className="empty-symbol">{icon('wave')}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function heading(
  eyebrow: string,
  title: ReactNode,
  sub: ReactNode,
  buttons: ReactNode = null
) {
  return (
    <div className="page-heading">
      <div>
        <div className="page-eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        <div className="subtitle">{sub}</div>
      </div>
      <div className="button-row">{buttons}</div>
    </div>
  );
}

export { markdown } from '../application/annotations/markdown';
