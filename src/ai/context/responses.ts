import { record } from '../../domain/value';

export interface ResponseContent {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
}
export interface ResponseInput {
  role?: string;
  type?: string;
  content?: string | ResponseContent[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}
export interface ResponseOutput extends Omit<ResponseInput, 'content'> {
  content?: ResponseContent[];
}
export interface ResponseData {
  status?: string;
  error?: { message: string };
  output: ResponseOutput[];
}

export function responseData(value: unknown): ResponseData {
  const data = record(value);
  if (data.error) throw new Error(String(record(data.error).message || '模型回應錯誤'));
  if (data.output !== undefined && !Array.isArray(data.output))
    throw new Error('模型 output 格式無效');
  const output = (Array.isArray(data.output) ? data.output : []).map(
    (value: unknown): ResponseOutput => {
      const item = record(value);
      if (typeof item.type !== 'string') throw new Error('模型 output 缺少 type');
      if (
        item.type === 'function_call' &&
        ['name', 'arguments', 'call_id'].some((key) => typeof item[key] !== 'string')
      )
        throw new Error('模型工具呼叫格式無效');
      if (item.content !== undefined && !Array.isArray(item.content))
        throw new Error('模型 content 格式無效');
      if (Array.isArray(item.content))
        for (const value of item.content as unknown[]) {
          const part = record(value);
          if (
            typeof part.type !== 'string' ||
            (part.type === 'output_text' && typeof part.text !== 'string')
          )
            throw new Error('模型文字回應格式無效');
        }
      return item as ResponseOutput;
    }
  );
  return { status: typeof data.status === 'string' ? data.status : undefined, output };
}
