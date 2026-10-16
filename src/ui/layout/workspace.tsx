import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Group, type Layout, Panel, Separator, useGroupRef } from 'react-resizable-panels';

const key = 'studio.workspace.layout';
const minimumWidths = { source: 300, notes: 360, agent: 360 };
const horizontalMinimum = minimumWidths.source + minimumWidths.notes + minimumWidths.agent + 10;
const defaults: Layout = {
  'meeting-source': 25,
  'meeting-notes': 47,
  'meeting-agent': 28,
};

function storedLayout(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    const sizes = Object.keys(defaults).map((id) => value?.[id]);
    if (
      sizes.every((size) => Number.isFinite(size) && size > 0) &&
      Math.abs(sizes.reduce((a, b) => a + b, 0) - 100) < 0.1
    )
      return value;
  } catch {}
  return defaults;
}

export function WorkspacePanels({ panes }: { panes: ReactNode[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const groupRef = useGroupRef();
  const layout = useRef(storedLayout());
  useLayoutEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const compact = entry.contentRect.width <= horizontalMinimum;
      setStacked(compact);
      cancelAnimationFrame(frame);
      if (!compact)
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => groupRef.current?.setLayout(layout.current));
        });
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [groupRef]);
  return (
    <div ref={host} className="workspace resizable-workspace">
      <Group
        id="meeting-workspace-layout"
        groupRef={groupRef}
        className={`workspace-panels ${stacked ? 'workspace-stacked' : ''}`}
        orientation={stacked ? 'vertical' : 'horizontal'}
        defaultLayout={layout.current}
        style={{
          width: '100%',
          height: stacked ? 1140 : '100%',
          flexShrink: 0,
        }}
        onLayoutChanged={(next, meta) => {
          if (stacked || !meta.isUserInteraction) return;
          layout.current = next;
          localStorage.setItem(key, JSON.stringify(next));
        }}
      >
        <Panel
          id="meeting-source"
          defaultSize="25%"
          minSize={stacked ? 300 : minimumWidths.source}
          maxSize={stacked ? undefined : '75%'}
        >
          <div className="workspace-panel-content">{panes[0]}</div>
        </Panel>
        <Separator
          className="workspace-separator"
          aria-label="調整會議來源寬度"
          disabled={stacked}
        />
        <Panel id="meeting-notes" defaultSize="47%" minSize={stacked ? 480 : minimumWidths.notes}>
          <div className="workspace-panel-content">{panes[1]}</div>
        </Panel>
        <Separator
          className="workspace-separator"
          aria-label="調整 Agent 助手寬度"
          disabled={stacked}
        />
        <Panel
          id="meeting-agent"
          defaultSize="28%"
          minSize={stacked ? 360 : minimumWidths.agent}
          maxSize={stacked ? undefined : '75%'}
        >
          <div className="workspace-panel-content">{panes[2]}</div>
        </Panel>
      </Group>
    </div>
  );
}
