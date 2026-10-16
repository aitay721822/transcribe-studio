export interface CodexTurn {
  id: string;
  status?: string;
  error?: { message: string };
}
export interface CodexNotification {
  threadId?: string;
  turnId?: string;
  turn?: CodexTurn;
  item?: { type: string; id: string; phase?: string; text?: string };
}
export interface CodexToolRequest {
  threadId: string;
  turnId?: string;
  tool?: string;
  arguments?: unknown;
  questions?: { id: string }[];
}
export interface CodexAccount {
  account?: { type?: string; email?: string; planType?: string };
  requiresOpenaiAuth?: boolean;
}
export interface CodexConfiguration {
  config?: { model?: string; model_provider?: string; mcp_servers?: Record<string, unknown> };
}
