import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { AiTransportError } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import { describeAiError } from './errors';

const body = (type: string) => ({
  type: 'error',
  error: { type, message: 'Request text the user must not see' },
});

/** An error as the SDK makes it from an error answer. */
const apiError = (status: number, type: string) =>
  APIError.generate(status, body(type), undefined, new Headers());

/** An `error` event in the middle of a stream: no status, only the error's type. */
const streamError = (type: 'overloaded_error' | 'rate_limit_error') =>
  new APIError(undefined, body(type), undefined, new Headers(), type);

describe('Ask Claude error messages', () => {
  it('maps the SDK’s typed errors to short, plain messages', () => {
    const cases: Array<[unknown, string, boolean]> = [
      [apiError(401, 'authentication_error'), 'Anthropic did not accept your API key', true],
      [apiError(403, 'permission_error'), 'not allowed to use this model', false],
      [apiError(404, 'not_found_error'), 'not available to your API key', false],
      [apiError(429, 'rate_limit_error'), 'rate limit', false],
      [apiError(529, 'overloaded_error'), 'overloaded', false],
      [streamError('overloaded_error'), 'overloaded', false],
      [streamError('rate_limit_error'), 'rate limit', false],
      [apiError(402, 'billing_error'), 'could not bill your account', false],
      [apiError(413, 'request_too_large'), 'too large to send', false],
      [apiError(400, 'invalid_request_error'), 'could not handle this request', false],
      [apiError(500, 'api_error'), 'service had a problem', false],
      [new APIConnectionTimeoutError(), 'took too long', false],
      [new APIConnectionError({ message: 'fetch failed' }), 'could not reach Anthropic', false],
      [new AiTransportError('no-key', 'x'), 'no longer stored', true],
      [new AiTransportError('no-access', 'x'), 'no longer allowed to connect', true],
      [new AiTransportError('invalid-key', 'x'), 'does not look like an Anthropic API key', true],
      [new AiTransportError('storage', 'x'), 'could not read or store your API key', false],
      [new AiTransportError('too-large', 'x'), 'too large to send', false],
      [new AiTransportError('blocked', 'x'), 'did not send this request', false],
      [new AiTransportError('network', 'x'), 'could not reach Anthropic', false],
      [new Error('anything'), 'Something went wrong', false],
    ];
    for (const [error, message, fixKey] of cases) {
      const failure = describeAiError(error);
      expect(failure.message, String(error)).toContain(message);
      expect(failure.fixKey, String(error)).toBe(fixKey);
      // Never the API's own words, which can quote the request.
      expect(failure.message).not.toContain('Request text');
    }
    expect(apiError(401, 'authentication_error')).toBeInstanceOf(AuthenticationError);
    expect(apiError(429, 'rate_limit_error')).toBeInstanceOf(RateLimitError);
  });

  it('looks inside the plain errors the message stream wraps failures in', () => {
    // The stream wraps what failed while an answer streamed, keeping it as the cause.
    const wrapped = new AnthropicError('The answer stopped part-way.');
    (wrapped as { cause?: unknown }).cause = new AiTransportError('network', 'x');
    expect(describeAiError(wrapped).message).toContain('could not reach Anthropic');
    expect(describeAiError(wrapped).detail).toBeUndefined();
  });

  it('says what an unrecognized failure was, briefly, so it can be reported', () => {
    const failure = describeAiError(new TypeError('body.getReader is not a function'));
    expect(failure.message).toContain('Something went wrong');
    expect(failure.detail).toBe('TypeError: body.getReader is not a function');
    const long = describeAiError(new Error(`line one\n${'x'.repeat(500)}`));
    expect(long.detail).toHaveLength(200);
    expect(long.detail).not.toContain('\n');
    // Recognized failures need no details.
    expect(describeAiError(apiError(529, 'overloaded_error')).detail).toBeUndefined();
  });
});
