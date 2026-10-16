import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';

export function DialogContents({
  title,
  children,
  footer,
  close,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  close: () => void;
}) {
  return (
    <>
      <div className="modal-head">
        <h2>{title}</h2>
        <Button variant="ghost" data-close-modal aria-label="關閉" onClick={close}>
          {icon('x')}
        </Button>
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-footer">{footer}</div> : null}
    </>
  );
}

export function NamePrompt({
  modal,
  title,
  label,
  initial,
  finish,
}: {
  modal: HTMLDialogElement;
  title: string;
  label: string;
  initial: string;
  finish: (value: string | null) => void;
}) {
  const [name, setName] = useState(initial),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const cancel = () => finish(null),
      close = () => {
        if (!modal.open) finish(null);
      };

    modal.addEventListener('cancel', cancel);
    modal.addEventListener('close', close);
    return () => {
      modal.removeEventListener('cancel', cancel);
      modal.removeEventListener('close', close);
    };
  }, [modal]);

  const confirm = () => {
    if (!name.trim()) {
      setError('請輸入名稱');
      input.current?.focus();
      return;
    }
    finish(name.trim());
  };

  return (
    <DialogContents
      title={title}
      close={() => finish(null)}
      footer={
        <>
          <Button className="btn" variant="outline" id="name-cancel" onClick={() => finish(null)}>
            取消
          </Button>
          <Button className="btn primary" id="name-confirm" onClick={confirm}>
            建立
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="name-input">{label}</label>
        <Input
          ref={input}
          id="name-input"
          value={name}
          maxLength={160}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirm();
            }
          }}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </DialogContents>
  );
}
