import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Select } from '../../../src/ui/primitives/select';

// Exercise options supplied through React props, without mutating React-owned DOM.
const container = document.createElement('div');
container.id = 'select-fixture';
container.className = 'panel';
Object.assign(container.style, {
  position: 'fixed',
  top: '180px',
  right: '30px',
  width: '300px',
  zIndex: '2',
});
document.body.append(container);
const root = createRoot(container);
flushSync(() =>
  root.render(
    <div className="field">
      <label htmlFor="fixture-project">測試專案</label>
      <Select id="fixture-project">
        <option value="default">預設專案</option>
        <option value="disabled" disabled>
          不可選取項目
        </option>
        {Array.from({ length: 24 }, (_, i) => (
          <option value={`fixture-${i + 1}`} key={i}>
            長清單測試 {i + 1}
          </option>
        ))}
      </Select>
    </div>
  )
);
(window as Window & { cleanupSelectFixture?: () => void }).cleanupSelectFixture = () => {
  root.unmount();
  container.remove();
};
