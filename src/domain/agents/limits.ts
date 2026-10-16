import type { LlmSettings } from '../models';

export function executionLimits(settings: Partial<LlmSettings>) {
  const integer = (
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
    label: string
  ) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max)
      throw new Error(`${label}須為 ${min}–${max} 的整數`);
    return result;
  };

  const maxSteps = integer(settings.maxSteps, 20, 1, 10000, '模型回合上限');
  return {
    maxSteps,
    maxToolCalls: integer(settings.maxToolCalls, maxSteps, 0, 10000, '工具呼叫上限'),
    timeoutMinutes: integer(settings.timeoutMinutes, 30, 0, 1440, '執行時間上限（分鐘）'),
  };
}

export type ExecutionLimits = ReturnType<typeof executionLimits>;
