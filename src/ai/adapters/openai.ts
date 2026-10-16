import { compressionSettings } from '../../domain/agents/compression';
import type { ImageData } from '../../domain/models';
import { compactInput } from '../context/compression';
import { textContext } from '../context/multimodal';
import { type ResponseContent, type ResponseInput, responseData } from '../context/responses';
import type { HarnessAdapter, HarnessContext } from '../contracts';

export class OpenAiAdapter implements HarnessAdapter {
  readonly id = 'openai';

  async execute(ctx: HarnessContext): Promise<string> {
    const content = (text: string, images: ImageData[] = []) =>
      images.length
        ? [
            { type: 'input_text', text },
            ...images.map((i) => ({ type: 'input_image', image_url: i.dataUrl, detail: 'auto' })),
          ]
        : text;

    const input: ResponseInput[] = [{ role: 'user', content: content(ctx.prompt, ctx.images) }];
    const steers: (string | ResponseContent[])[] = [];
    const compact = compressionSettings(ctx.settings.llm);
    let tailStart = 1,
      lastAttemptSize = 0;
    ctx.bindSteer?.(async (text, images) => {
      if (ctx.signal.aborted) return false;
      steers.push(content(text, images));
      return true;
    });
    try {
      for (let step = 0; step < ctx.maxSteps; step++) {
        ctx.signal.throwIfAborted();
        const size = textContext(input).length;
        if (
          !ctx.ephemeral &&
          compact.autoCompact &&
          tailStart > 1 &&
          size >= compact.compactThreshold &&
          size > lastAttemptSize * 1.5 &&
          step < ctx.maxSteps - 1
        ) {
          // A summary request consumes one of the same model-request budget.
          lastAttemptSize = size;
          await compactInput(ctx, input, tailStart);
          step++;
        }
        input.push(...steers.splice(0).map((content) => ({ role: 'user', content })));
        if (step === ctx.maxSteps - 1) ctx.bindSteer?.(null);
        ctx.emit({ type: 'log', message: `OpenAI 正在整理資料 · 第 ${step + 1} 步` });
        const response = await fetch(`${ctx.settings.llm.baseUrl.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          signal: ctx.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ctx.settings.llm.apiKey}`,
          },
          body: JSON.stringify({
            model: ctx.settings.llm.model,
            instructions: ctx.instructions,
            input,
            store: false,
            tools: ctx.tools.specs().map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
              strict: false,
            })),
            max_output_tokens: 10000,
            ...(ctx.result
              ? {
                  text: {
                    format: {
                      type: 'json_schema',
                      name: 'marked_revision',
                      strict: true,
                      schema: ctx.result.schema,
                    },
                  },
                }
              : {}),
          }),
        });
        if (!response.ok)
          throw new Error(
            `模型請求失敗 (${response.status})${ctx.images?.length && response.status === 400 ? '，請確認目前模型與端點支援圖片輸入' : ''}`
          );
        const data = responseData(await response.json());
        if (data.error) throw new Error(data.error.message);
        const output = data.output || [];
        tailStart = input.length;
        input.push(...output);
        const calls = output.filter((o) => o.type === 'function_call');
        if (!calls.length) {
          if (data.status === 'incomplete') throw new Error('模型輸出達到上限，請縮小修訂範圍');
          if (steers.length) continue;
          ctx.bindSteer?.(null);
          const text = output
            .filter((o) => o.type === 'message')
            .flatMap((o) => o.content || [])
            .filter((c) => c.type === 'output_text')
            .map((c) => c.text)
            .join('\n');
          return ctx.result ? ctx.result.parse(text) : text;
        }
        for (const call of calls) {
          ctx.signal.throwIfAborted();
          let result: unknown;
          try {
            result = await ctx.tools.call(call.name, JSON.parse(call.arguments));
          } catch (caughtError) {
            const error =
              caughtError instanceof Error ? caughtError : new Error(String(caughtError));

            if (ctx.signal.aborted) throw error;
            result = { error: error.message };
          }
          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result ?? null),
          });
        }
      }
      throw new Error('已達到 Agent 步數上限，請縮小問題範圍');
    } finally {
      ctx.bindSteer?.(null);
    }
  }
}
