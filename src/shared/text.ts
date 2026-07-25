const WINDOWS_RESERVED = /[<>:"/\\|?*]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'please',
  'that',
  'the',
  'this',
  'to',
  'we',
  'what',
  'with',
  'would',
  'you'
])

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function sanitizeFilename(input: string, fallback = 'untitled', maxLength = 80): string {
  const withoutControlCharacters = [...input]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
  const normalized = normalizeWhitespace(withoutControlCharacters)
    .replace(WINDOWS_RESERVED, '-')
    .replace(/\.+$/g, '')
    .replace(/^-+|-+$/g, '')
  const safe =
    !normalized || RESERVED_NAMES.test(normalized)
      ? `${fallback}-${normalized || 'item'}`
      : normalized
  return safe.slice(0, maxLength).trim() || fallback
}

export function slugify(input: string, fallback = 'untitled'): string {
  const words = sanitizeFilename(input, fallback, 100)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return (words || fallback).slice(0, 72)
}

export function deterministicTitle(input: string, maxLength = 64): string {
  const clean = normalizeWhitespace(
    input
      .replace(/[`*_#>()]/g, ' ')
      .replaceAll('[', ' ')
      .replaceAll(']', ' ')
  )
  const tokens = clean.split(' ').filter(Boolean)
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token.toLowerCase()))
  const selected = (meaningful.length >= 2 ? meaningful : tokens).slice(0, 10).join(' ')
  const safe = sanitizeFilename(selected || 'New chat', 'New chat', maxLength)
  return safe.charAt(0).toUpperCase() + safe.slice(1)
}

export function normalizeForComparison(input: string): string {
  return normalizeWhitespace(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, ' ')
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

export function keywords(input: string): Set<string> {
  return new Set(
    normalizeForComparison(input)
      .split(' ')
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  )
}

export function excerpt(input: string, maxLength = 220): string {
  const clean = normalizeWhitespace(input)
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`
}
