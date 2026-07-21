import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import { extractionOutputSchema, messageSchema } from '../../src/shared/schemas'
import { redactSecrets } from '../../src/shared/security'
import { deterministicTitle, sanitizeFilename } from '../../src/shared/text'

describe('shared invariants', () => {
  it('generates prefixed immutable UUID identifiers', () => {
    const first = createId('msg')
    const second = createId('msg')
    expect(first).toMatch(/^msg_[a-f0-9-]{36}$/)
    expect(second).not.toBe(first)
  })

  it('sanitizes Windows filenames and reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('untitled-CON')
    expect(sanitizeFilename('  supplier: quote?.txt.  ')).toBe('supplier- quote-.txt')
    expect(sanitizeFilename('../escape\\path')).not.toMatch(/[\\/:*?"<>|]/)
    expect(sanitizeFilename(`ok\u0000name`)).toBe('okname')
  })

  it('creates a deterministic useful title without an AI call', () => {
    expect(deterministicTitle('Please help me decide the initial supplier quantity for the product')).toBe(
      'Help me decide initial supplier quantity product'
    )
  })

  it('validates message states and extraction provenance shape', () => {
    const now = new Date().toISOString()
    const message = messageSchema.parse({
      message_id: createId('msg'),
      chat_id: createId('chat'),
      role: 'assistant',
      content: 'partial',
      created_at: now,
      updated_at: now,
      provider: 'mock',
      model: 'mock',
      status: 'interrupted',
      sequence: 1,
      retrieved_memory_ids: []
    })
    expect(message.status).toBe('interrupted')
    expect(() => extractionOutputSchema.parse({ candidates: [{ type: 'decision' }] })).toThrow()
  })

  it('redacts API keys and authorization values', () => {
    const redacted = redactSecrets(
      'api_key=sk-supersecret123 Authorization: Bearer abcdefghijklmnop token=github_pat-secretvalue'
    )
    expect(redacted).not.toContain('supersecret')
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).toContain('[REDACTED]')
  })
})
