import {
  Children,
  type ComponentProps,
  Fragment,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { registerDropdown } from '../components/dropdown';
import { icon } from '../components/icons';
import { Button } from './button';
import { Input } from './input';

interface Entry {
  value: string;
  label: string;
  group: string;
  disabled: boolean;
  selected: boolean;
}

function optionText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{
        children?: ReactNode;
      }>(child)
        ? optionText(child.props.children)
        : String(child)
    )
    .join('');
}

function entriesFrom(children: ReactNode, group = '', disabled = false): Entry[] {
  const entries: Entry[] = [];
  Children.forEach(children, (child) => {
    if (
      !isValidElement<{
        value?: string | number;
        label?: string;
        children?: ReactNode;
        disabled?: boolean;
        'data-selected'?: boolean;
      }>(child)
    )
      return;
    const p = child.props;
    if (child.type === 'option')
      entries.push({
        value: String(p.value ?? p.children),
        label: p.label || optionText(p.children),
        group,
        disabled: disabled || p.disabled,
        selected: !!p['data-selected'],
      });
    else
      entries.push(
        ...entriesFrom(
          p.children,
          child.type === 'optgroup' ? p.label : group,
          disabled || p.disabled
        )
      );
  });
  return entries;
}

export function Select({
  children,
  className = '',
  onChange,
  popupWidth = 280,
  wrapOptions = false,
  ...props
}: ComponentProps<'select'> & { popupWidth?: number; wrapOptions?: boolean }) {
  const entries = entriesFrom(children);
  const preferred = entries.find((e) => e.selected)?.value;
  const [chosen, setChosen] = useState(
    String(props.value ?? props.defaultValue ?? preferred ?? entries[0]?.value ?? '')
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [name, setName] = useState(props['aria-label'] || '選項');
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const id = props.id || `studio-select-${generatedId}`;
  const value = props.value !== undefined ? String(props.value) : chosen;
  const visible = entries.filter((e) =>
    `${e.label} ${e.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  useEffect(() => {
    if (preferred !== undefined) setChosen(preferred);
  }, [preferred]);
  useLayoutEffect(() => {
    const label = props.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(props.id)}"]`)
      : null;
    setName(
      props['aria-label'] ||
        label?.textContent?.trim() ||
        native.current?.closest('.field')?.querySelector('label')?.textContent?.trim() ||
        '選項'
    );
  }, [props.id, props['aria-label']]);

  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const box = popup.current;
    box.showPopover();

    const reposition = () => {
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(
        Math.max(240, wrapOptions ? popupWidth : Math.min(popupWidth, rect.width)),
        innerWidth - 24
      );
      const below = innerHeight - rect.bottom - 18,
        above = rect.top - 18;
      const upward = below < 180 && above > below;
      box.style.width = `${width}px`;
      box.style.maxHeight = `${Math.min(380, Math.max(80, upward ? above : below))}px`;
      box.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
      box.style.top = `${upward ? Math.max(12, rect.top - box.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
    };

    reposition();
    search.current?.focus();

    const outside = (event: PointerEvent) => {
      if (!box.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        close();
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
      }
    };

    const unregister = registerDropdown(() => close());
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => {
      unregister();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [open, popupWidth, wrapOptions]);
  useEffect(() => {
    popup.current?.querySelector(`#${CSS.escape(id)}-option-${active}`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active, query, id]);

  const choose = (entry: Entry) => {
    if (entry.disabled) return;
    setChosen(entry.value);
    native.current.value = entry.value;
    native.current.dispatchEvent(
      new Event('change', {
        bubbles: true,
      })
    );
    close(true);
  };

  const toggle = () => {
    if (open) close(true);
    else {
      setQuery('');
      setActive(
        Math.max(
          0,
          entries.findIndex((e) => e.value === value)
        )
      );
      setOpen(true);
    }
  };

  return (
    <div className="dropdown-control" data-slot="select">
      <select
        {...props}
        ref={native}
        value={value}
        className={`dropdown-native ${className}`}
        tabIndex={-1}
        aria-hidden="true"
        data-dropdown-ready="true"
        onChange={(event) => {
          setChosen(event.target.value);
          onChange?.(event);
        }}
      >
        {children}
      </select>
      <Button
        variant="outline"
        ref={trigger}
        id={`${id}-trigger`}
        className="dropdown-trigger"
        role="combobox"
        aria-label={`${name}：${entries.find((e) => e.value === value)?.label || '請選擇…'}`}
        title={entries.find((e) => e.value === value)?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined}
        disabled={props.disabled || !entries.length}
        onClick={toggle}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="dropdown-value">
          {entries.find((e) => e.value === value)?.label || '請選擇…'}
        </span>
        <span className="dropdown-chevron">{icon('down')}</span>
      </Button>
      {open &&
        createPortal(
          <div
            className={`dropdown-popup${wrapOptions ? ' device-options' : ''}`}
            ref={popup}
            data-dropdown-owner={id}
            popover="manual"
          >
            <div className="dropdown-search">
              {icon('search')}
              <Input
                ref={search}
                type="search"
                placeholder={`搜尋${name}`}
                aria-label={`搜尋${name}`}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                aria-controls={`${id}-options`}
                aria-activedescendant={visible[active] ? `${id}-option-${active}` : undefined}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const enabled = visible
                      .map((e, i) => (e.disabled ? -1 : i))
                      .filter((i) => i >= 0);
                    if (!enabled.length) return;
                    const i = enabled.indexOf(active);

                    const destinationOption = () => {
                      if (event.key === 'Home') {
                        return enabled[0];
                      }
                      if (event.key === 'End') {
                        return enabled.at(-1);
                      }
                      return enabled[
                        (i + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
                      ];
                    };

                    setActive(destinationOption());
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (visible[active]) choose(visible[active]);
                  } else if (event.key === 'Tab') close(true);
                }}
              />
            </div>
            <div className="dropdown-options" id={`${id}-options`} role="listbox" aria-label={name}>
              {visible.map((entry, i) => (
                <Fragment key={entry.value}>
                  {entry.group && entry.group !== visible[i - 1]?.group ? (
                    <div className="dropdown-group">{entry.group}</div>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="bare"
                    type="button"
                    tabIndex={-1}
                    id={`${id}-option-${i}`}
                    role="option"
                    className={`dropdown-option ${active === i ? 'is-active' : ''}`}
                    aria-selected={entry.value === value}
                    title={entry.label}
                    disabled={entry.disabled}
                    onPointerMove={() => !entry.disabled && setActive(i)}
                    onClick={() => choose(entry)}
                  >
                    <span>{entry.label}</span>
                    <span className="dropdown-check">
                      {entry.value === value ? icon('check') : null}
                    </span>
                  </Button>
                </Fragment>
              ))}
              {!visible.length && <div className="dropdown-empty">沒有符合的選項</div>}
            </div>
          </div>,
          trigger.current?.closest('dialog') || document.body
        )}
    </div>
  );
}
