import { describe, it, expect, vi, beforeEach } from 'vitest';

// extract/anthropic.js constructs its Anthropic client (and reads EXTRACTION_MODEL)
// at module load time, so these need real-looking values before the dynamic import
// below executes — same reasoning as extract/run.test.ts's top-of-file env stubs.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { parse: mocks.parse };
  },
}));

const { extractSample } = await import('../../src/extract/anthropic.js');

describe('extractSample', () => {
  beforeEach(() => {
    mocks.parse.mockReset();
  });

  it('resolves with the parsed output on a normal successful call', async () => {
    mocks.parse.mockResolvedValue({
      parsed_output: { invoice_number: 'INV-1' },
      usage: { input_tokens: 120, output_tokens: 40 },
      stop_reason: 'end_turn',
    });

    const result = await extractSample({ fields: [], pages: [] });

    expect(result).toEqual({
      parsed: { invoice_number: 'INV-1' },
      rawResponse: { parsed_output: { invoice_number: 'INV-1' }, usage: { input_tokens: 120, output_tokens: 40 }, stop_reason: 'end_turn' },
      inputTokens: 120,
      outputTokens: 40,
      stopReason: 'end_turn',
    });
  });

  // The regression this guards: client.messages.parse() throws (rather than
  // resolving with parsed_output: null) when its own client-side JSON parse of the
  // model's text fails — e.g. a response truncated at the max_tokens ceiling. This
  // is one of N concurrent samples awaited via Promise.all in extract/run.ts; an
  // uncaught throw here used to take every other in-flight sample down with it
  // instead of just this one sample gracefully failing.
  it('resolves with a gracefully-failed sample instead of throwing when the SDK parse fails', async () => {
    mocks.parse.mockRejectedValue(new Error('Could not parse response content as the length limit was reached'));

    await expect(extractSample({ fields: [], pages: [] })).resolves.toEqual({
      parsed: null,
      rawResponse: { error: 'Could not parse response content as the length limit was reached' },
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'parse_error',
    });
  });

  it('resolves gracefully even when the rejection is not an Error instance', async () => {
    mocks.parse.mockRejectedValue('a plain string rejection');

    const result = await extractSample({ fields: [], pages: [] });
    expect(result.parsed).toBeNull();
    expect(result.rawResponse).toEqual({ error: 'a plain string rejection' });
  });
});
