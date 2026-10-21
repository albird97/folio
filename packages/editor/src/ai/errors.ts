import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { AiTransportError } from '@folio/platform-adapters';

export interface AiFailure {
  /** Short and plain; never the API's own message, which can quote the request. */
  message: string;
  /** Setting up the key again is the way out. */
  fixKey: boolean;
  /**
   * For failures Folio does not recognize: the error's type and message, so
   * the user can report what went wrong. Never document text (errors carry
   * none) and never the API's own message.
   */
  detail?: string;
}

const failure = (message: string, fixKey = false): AiFailure => ({ message, fixKey });

const MAX_DETAIL = 200;

/** "TypeError: …", on one line and short. */
function detailOf(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `${typeof error}: ${String(error)}`;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

/**
 * Turns what a request to Anthropic failed with into a message for the
 * user. The SDK's typed errors are checked most specific first; errors in
 * the middle of an answer carry no HTTP status, only the API's error type.
 */
export function describeAiError(error: unknown, depth = 0): AiFailure {
  // The SDK's message stream wraps anything that fails while an answer
  // streams (Folio's own transport errors included) in a plain AnthropicError
  // that keeps the original as its cause.
  if (
    error instanceof AnthropicError &&
    !(error instanceof APIError) &&
    error.cause !== undefined &&
    depth < 3
  ) {
    return describeAiError(error.cause, depth + 1);
  }
  if (error instanceof AiTransportError) {
    switch (error.code) {
      case 'invalid-key':
        return failure('That does not look like an Anthropic API key.', true);
      case 'no-key':
        return failure('Your API key is no longer stored. Set up Ask Claude again.', true);
      case 'no-access':
        return failure(
          'Folio is no longer allowed to connect to Anthropic. Set up Ask Claude again to allow it.',
          true,
        );
      case 'too-large':
        return failure('The text of these pages is too large to send. Choose fewer pages.');
      case 'storage':
        return failure('Folio could not read or store your API key. Try again.');
      case 'blocked':
        return failure('Folio did not send this request.');
      case 'network':
        return failure('Folio could not reach Anthropic. Check your internet connection.');
    }
  }
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIError && error.type === 'timeout_error')
  ) {
    return failure('Claude took too long to answer. Try again.');
  }
  if (error instanceof APIConnectionError) {
    return failure('Folio could not reach Anthropic. Check your internet connection.');
  }
  if (error instanceof AuthenticationError) {
    return failure('Anthropic did not accept your API key. Check it and set it up again.', true);
  }
  if (error instanceof PermissionDeniedError) {
    return failure('Your API key is not allowed to use this model. Choose another in settings.');
  }
  if (error instanceof NotFoundError) {
    return failure('This model is not available to your API key. Choose another in settings.');
  }
  if (
    error instanceof RateLimitError ||
    (error instanceof APIError && error.type === 'rate_limit_error')
  ) {
    return failure('Your API key has reached its rate limit. Wait a moment and try again.');
  }
  if (error instanceof APIError && (error.status === 529 || error.type === 'overloaded_error')) {
    return failure('Claude is overloaded right now. Try again in a moment.');
  }
  if (error instanceof APIError && (error.status === 402 || error.type === 'billing_error')) {
    return failure(
      'Anthropic could not bill your account. Check your plan and credits in the Claude Console.',
    );
  }
  if (error instanceof APIError && error.status === 413) {
    return failure('The text of these pages is too large to send. Choose fewer pages.');
  }
  if (error instanceof BadRequestError) {
    return failure('Anthropic could not handle this request.');
  }
  if (error instanceof APIError) {
    return failure('Anthropic’s service had a problem. Try again.');
  }
  return {
    ...failure('Something went wrong while asking Claude. Try again.'),
    detail: detailOf(error),
  };
}
