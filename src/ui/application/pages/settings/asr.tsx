import { SpeechServices } from '../../../audio/configuration/services';
import type { PageContext } from '../contracts';

export function asrSettings({ state }: PageContext) {
  return <SpeechServices config={state.settings.asr} />;
}
