import type { TaskFilter } from '../../../domain/asr/tasks';
import { taskSource, taskState } from '../../../domain/asr/tasks';
import type { UiState } from '../../../domain/models';
import { Select } from '../../primitives/select';
import { sourceLabels, taskLabels } from './card';

export function TaskFilters({
  state,
  filter,
  change,
}: {
  state: UiState;
  filter: TaskFilter;
  change(next: TaskFilter): void;
}) {
  return (
    <div className="asr-task-filters project-task-filters">
      <div className="field">
        <label htmlFor="tasks-meeting">會議</label>
        <Select
          id="tasks-meeting"
          value={filter.meetingId || ''}
          onChange={(event) =>
            change({ ...filter, meetingId: event.target.value || undefined, offset: 0 })
          }
        >
          <option value="">所有會議</option>
          {state.meetings
            .filter((meeting) => !filter.projectId || meeting.projectId === filter.projectId)
            .map((meeting) => (
              <option value={meeting.id} key={meeting.id}>
                {meeting.title}
              </option>
            ))}
        </Select>
      </div>
      <div className="field">
        <label htmlFor="tasks-source">來源</label>
        <Select
          id="tasks-source"
          value={filter.source || ''}
          onChange={(event) => {
            const source = taskSource.safeParse(event.target.value);
            change({ ...filter, source: source.success ? source.data : undefined, offset: 0 });
          }}
        >
          <option value="">所有來源</option>
          {taskSource.options.map((source) => (
            <option key={source} value={source}>
              {sourceLabels[source]}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label htmlFor="tasks-state">狀態</label>
        <Select
          id="tasks-state"
          value={filter.state || ''}
          onChange={(event) => {
            const status = taskState.safeParse(event.target.value);
            change({ ...filter, state: status.success ? status.data : undefined, offset: 0 });
          }}
        >
          <option value="">所有狀態</option>
          {taskState.options.map((status) => (
            <option key={status} value={status}>
              {taskLabels[status]}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
