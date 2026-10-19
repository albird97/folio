import type { PageId } from '@folio/document-model';
import { describe, expect, it } from 'vitest';
import {
  askParams,
  buildMessages,
  citedPages,
  countParams,
  documentBlock,
  documentBytes,
  SYSTEM_PROMPT,
  type AiDocument,
} from './prompt';

const DOCUMENT: AiDocument = {
  pages: [
    { pageId: 'page_a' as PageId, pageNumber: 1, text: 'Quarterly report' },
    { pageId: 'page_c' as PageId, pageNumber: 3, text: 'Revenue grew 12%.\nCosts fell.' },
  ],
  pagesRead: 3,
};

const HISTORY = [{ question: 'Summarize this document.', answer: 'A quarterly report.' }];

describe('Ask Claude prompts', () => {
  it('sends one content block per page, each naming its page', () => {
    expect(documentBlock(DOCUMENT)).toEqual({
      type: 'document',
      source: {
        type: 'content',
        content: [
          { type: 'text', text: 'Page 1\n\nQuarterly report' },
          { type: 'text', text: 'Page 3\n\nRevenue grew 12%.\nCosts fell.' },
        ],
      },
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    });
  });

  it('opens the conversation with the document, then the questions and answers', () => {
    expect(buildMessages(DOCUMENT, HISTORY, 'What grew?')).toEqual([
      {
        role: 'user',
        content: [documentBlock(DOCUMENT), { type: 'text', text: 'Summarize this document.' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'A quarterly report.' }] },
      { role: 'user', content: [{ type: 'text', text: 'What grew?' }] },
    ]);
  });

  it('repeats the same prefix in every request, so the cache can serve it', () => {
    const first = askParams('claude-opus-5-5', DOCUMENT, [], 'Summarize this document.');
    const second = askParams('claude-opus-5-5', DOCUMENT, HISTORY, 'What grew?');
    // System prompt and document are byte for byte the same.
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
    expect(JSON.stringify(second.messages[0]!.content)).toBe(
      JSON.stringify(first.messages[0]!.content),
    );
    // The first request is a prefix of the second, apart from what follows it.
    expect(JSON.stringify(second.messages.slice(0, 1))).toBe(JSON.stringify(first.messages));
    // Nothing that changes per request is in the system prompt.
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|page_/);
    // One breakpoint after the document, and automatic caching of the conversation.
    expect(JSON.stringify(second).match(/"cache_control"/g)).toHaveLength(2);
    expect(second.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('asks with adaptive thinking, medium effort, a generous limit and fallbacks', () => {
    expect(askParams('claude-opus-5-5', DOCUMENT, [], 'Hi')).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(askParams('claude-sonnet-5-5', DOCUMENT, [], 'Hi')).toMatchObject({
      fallbacks: 'default',
    });
    // Haiku has no server-side fallback: the parameter would be refused.
    const haiku = askParams('claude-haiku-5-5', DOCUMENT, [], 'Hi');
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku).not.toHaveProperty('betas');
    for (const params of [haiku, askParams('claude-opus-5-5', DOCUMENT, [], 'Hi')]) {
      expect(params).not.toHaveProperty('temperature');
      expect(params).not.toHaveProperty('stream');
    }
  });

  it('counts the first request exactly as it will be sent', () => {
    const counted = countParams('claude-opus-5-5', DOCUMENT, 'Summarize this document.');
    const sent = askParams('claude-opus-5-5', DOCUMENT, [], 'Summarize this document.');
    expect(counted).toEqual({ model: sent.model, system: sent.system, messages: sent.messages });
  });

  it('maps citations to the pages they name', () => {
    const citation = {
      type: 'content_block_location' as const,
      cited_text: 'Page 3…',
      document_index: 0,
      document_title: null,
      file_id: null,
      start_block_index: 1,
      end_block_index: 2,
    };
    expect(citedPages(DOCUMENT, citation).map((page) => page.pageNumber)).toEqual([3]);
    expect(
      citedPages(DOCUMENT, { ...citation, start_block_index: 0 }).map((page) => page.pageNumber),
    ).toEqual([1, 3]);
    expect(citedPages(DOCUMENT, { ...citation, document_index: 1 })).toEqual([]);
  });

  it('estimates the size of a request from its text', () => {
    expect(documentBytes(DOCUMENT)).toBeGreaterThan(
      new TextEncoder().encode(JSON.stringify(documentBlock(DOCUMENT).source)).byteLength,
    );
  });
});
