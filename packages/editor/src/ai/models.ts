/**
 * The Claude models the user can choose for Ask Claude. The choice is theirs
 * (they pay for it with their own key); Folio defaults to the most capable.
 */
export const AI_MODELS = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Most capable. The default.',
    // A server-side retry on another model when a safety classifier declines.
    fallbacks: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    description: 'Faster, and costs about half as much.',
    fallbacks: true,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    description: 'Fastest, and costs the least.',
    // Haiku has no server-side fallback; the parameter would be refused.
    fallbacks: false,
  },
] as const;

export type AiModel = (typeof AI_MODELS)[number]['id'];

export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';

export const isAiModel = (value: unknown): value is AiModel =>
  AI_MODELS.some((model) => model.id === value);

export const aiModel = (id: AiModel) => AI_MODELS.find((model) => model.id === id)!;
