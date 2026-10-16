import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icon } from '../../../components/icons';
import { Button } from '../../../primitives/button';
import { Disclosure, DisclosureTrigger } from '../../../primitives/disclosure';
import { Input } from '../../../primitives/input';
import { Select } from '../../../primitives/select';
import { referenceKey } from './chips';
import type { useMentions } from './controller';
import { useMentionPosition } from './position';

export function isMentionFocusTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.mention-menu')) return true;
  const owner = target.closest<HTMLElement>('[data-dropdown-owner]')?.dataset.dropdownOwner;
  return !!owner && !!document.getElementById(`${owner}-trigger`)?.closest('.mention-menu');
}

export function MentionMenu({ menu }: { menu: ReturnType<typeof useMentions> }) {
  const [root, setRoot] = useState(menu.project?.roots[0]?.id || '');
  const [path, setPath] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const direct = useRef<HTMLDetailsElement>(null);
  const position = useMentionPosition(!!menu.token);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [menu.selected]);
  if (!menu.token) return null;

  const scanStatus = () => {
    if (menu.loading) {
      return '正在背景搜尋…';
    }
    if (menu.page) {
      return `本批 ${menu.page.files.length} 筆 · 已檢查 ${menu.page.stats.visited} 項${menu.page.nextCursor ? ' · 尚未掃描完畢' : ' · 搜尋完成'}`;
    }
    return '';
  };

  return createPortal(
    <div
      className="mention-menu"
      style={position}
      aria-label="指定參考來源"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="mention-heading">
        <span>新增</span>
        <Button
          variant="ghost"
          size="bare"
          type="button"
          aria-label="關閉參考選單"
          onClick={menu.close}
        >
          ×
        </Button>
      </div>
      <Button
        variant="ghost"
        size="bare"
        type="button"
        className="mention-action"
        disabled={!menu.project?.roots.length}
        onClick={() => {
          if (direct.current) {
            direct.current.open = true;
            direct.current.scrollIntoView({ block: 'nearest' });
            direct.current.querySelector('input')?.focus();
          }
        }}
      >
        {icon('folder')}
        <strong>檔案和資料夾</strong>
        <span>指定來源路徑</span>
      </Button>
      <Button
        variant="ghost"
        size="bare"
        type="button"
        className="mention-action"
        onClick={() => {
          menu.close();
          document.getElementById('agent-image-picker')?.click();
        }}
      >
        {icon('file')}
        <strong>圖片</strong>
        <span>加入圖片附件</span>
      </Button>
      {!menu.project?.roots.length && <p className="help">請先在專案加入參考資料夾。</p>}
      <div className="mention-section-label">專案來源</div>
      <div
        className="mention-options"
        role="listbox"
        id="agent-reference-list"
        aria-label="參考來源"
        ref={list}
      >
        {menu.options.map((r, i) => {
          const referenceIcon = () => {
            if (r.kind === 'search') {
              return 'search';
            }
            if (r.kind === 'directory') {
              return 'folder';
            }
            return 'file';
          };

          return (
            <Button
              variant="ghost"
              size="bare"
              type="button"
              role="option"
              aria-selected={i === menu.selected}
              id={`reference-option-${i}`}
              key={referenceKey(r)}
              data-reference-kind={r.kind}
              data-reference-path={r.kind === 'search' ? r.query : r.relative}
              title={
                r.kind === 'search'
                  ? `交給 Agent 搜尋「${r.query}」`
                  : `${r.rootName}/${r.relative}`
              }
              onClick={() => void menu.choose(r)}
            >
              <span className="mention-glyph">{icon(referenceIcon())}</span>
              <span className="mention-row-text">
                <strong>
                  {r.kind === 'search'
                    ? `交給 Agent 搜尋「${r.query}」`
                    : r.relative.split(/[\\/]/).at(-1) || r.rootName}
                </strong>
                <span>
                  {r.kind === 'search'
                    ? '實際搜尋檔名與內文，找到後分段讀取'
                    : `${r.kind === 'directory' ? '資料夾' : '文件'} · ${r.rootName}/${r.relative}`}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
      {!menu.token.query && menu.skills.length > 0 && (
        <>
          <div className="mention-section-label">Skills</div>
          <div className="mention-skills">
            {menu.skills.map((skill) => (
              <Button
                variant="ghost"
                size="bare"
                type="button"
                className="mention-action"
                key={skill.id}
                onClick={() => menu.chooseSkill(skill.id)}
                title={skill.description}
              >
                {icon('sparkle')}
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </Button>
            ))}
          </div>
        </>
      )}
      <p className="help mention-progress" role="status">
        {scanStatus()}
      </p>
      {!menu.loading && menu.page && !menu.page.files.length && (
        <p className="help">本批沒有符合項目，可繼續搜尋或交給 Agent 搜尋關鍵字。</p>
      )}
      {!!menu.page?.stats.errorCount && (
        <p className="help">{menu.page.stats.errorCount} 個項目無法讀取；搜尋結果可能不完整。</p>
      )}
      {menu.page?.nextCursor && (
        <Button
          variant="ghost"
          size="bare"
          type="button"
          className="mention-more"
          disabled={menu.loading}
          onClick={menu.more}
        >
          繼續搜尋／下一批
        </Button>
      )}
      {menu.project?.roots.length > 0 && (
        <Disclosure className="mention-direct" ref={direct}>
          <DisclosureTrigger>已知路徑？直接指定</DisclosureTrigger>
          <label>
            參考資料夾
            <Select
              aria-label="路徑所屬資料夾"
              value={root}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setRoot(e.target.value)}
            >
              {menu.project.roots.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            相對路徑
            <Input
              aria-label="直接指定相對路徑"
              placeholder="例如 規格/設計.md，留空指定整個資料夾"
              value={path}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  void menu.resolve(root, path);
                }
              }}
            />
          </label>
          <Button
            variant="ghost"
            size="bare"
            type="button"
            onClick={() => void menu.resolve(root, path)}
          >
            加入指定路徑
          </Button>
        </Disclosure>
      )}
      {menu.error && (
        <p className="help error" role="alert">
          {menu.error}
        </p>
      )}
    </div>,
    document.body
  );
}
