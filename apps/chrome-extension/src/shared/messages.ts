import { z } from './zod';
import { activityKindSchema, type ActivityEntry } from './activity';

/**
 * Every runtime message is validated against this schema by the service
 * worker. Messages carry no document bytes and no document content: the
 * only optional detail is a file name, stored only if the user opted in.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024;

export const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('activity/record'),
    kind: activityKindSchema,
    pageCount: z.number().int().positive().max(1_000_000).optional(),
    fileName: z.string().max(255).optional(),
  }),
  z.object({ type: z.literal('activity/clear') }),
  z.object({
    type: z.literal('editor/open'),
    handoffId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  }),
  z.object({
    type: z.literal('editor/open-url'),
    url: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal('status/get') }),
]);

export type ExtensionMessage = z.infer<typeof messageSchema>;

export interface ExtensionStatus {
  version: string;
}

export type MessageResponse =
  | { ok: true; activity?: ActivityEntry[]; status?: ExtensionStatus }
  | { ok: false; error: 'invalid-message' | 'forbidden-sender' | 'failed' };

export function parseMessage(value: unknown): ExtensionMessage | null {
  try {
    if (JSON.stringify(value).length > MAX_MESSAGE_BYTES) return null;
  } catch {
    return null;
  }
  const result = messageSchema.safeParse(value);
  return result.success ? result.data : null;
}

export async function sendMessage(message: ExtensionMessage): Promise<MessageResponse> {
  try {
    return (
      ((await chrome.runtime.sendMessage(message)) as MessageResponse | undefined) ?? {
        ok: false,
        error: 'failed',
      }
    );
  } catch {
    return { ok: false, error: 'failed' };
  }
}
