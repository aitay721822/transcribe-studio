import { agentModel } from '../../../domain/agents/auth';
import type { UiState } from '../../../domain/models';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Select } from '../../primitives/select';
import { agentActions } from '../composer';
import { PermissionMenu } from '../session/permissions';

export function ComposerControls({
  state,
  openSources,
  sourcesOpen,
}: {
  state: UiState;
  openSources(): void;
  sourcesOpen: boolean;
}) {
  const llm = state.settings.llm;

  const backendName = () => {
    if (llm.backend === 'claude') {
      return 'Claude';
    }
    if (llm.backend === 'codex') {
      return 'Codex';
    }
    return 'OpenAI';
  };

  const backend = backendName();
  const model = agentModel(llm);
  return (
    <div className="composer-toolbar">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="composer-add"
        aria-label="新增檔案或資料夾"
        title="新增檔案或資料夾"
        aria-expanded={sourcesOpen}
        aria-controls={sourcesOpen ? 'agent-reference-list' : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openSources}
      >
        {icon('plus')}
      </Button>
      <PermissionMenu state={state} />
      <div className="composer-choices">
        <Select id="skill-select" aria-label="選擇 skill">
          <option value="">自動 skill</option>
          {state.skills.map((skill) => (
            <option value={skill.id} key={skill.id}>
              {skill.name}
            </option>
          ))}
        </Select>
        {model ? (
          <span
            className="composer-model"
            title={`${backend} · ${model}`}
            aria-label={`目前模型：${model}`}
          >
            {model}
          </span>
        ) : null}
        <span id="agent-send-actions">{agentActions(state)}</span>
      </div>
    </div>
  );
}
