import { describe, expect, it } from 'vitest';
import { redactPhone, redactText } from '@/lib/redact';

// Display redaction (US-SSBA-003 / PRD §7): phone first 3 + last 4. Value redaction only — the extension
// holds no API keys (DEC-009).

describe('redactPhone', () => {
  it('masks phones with >6 digits to first 3 + last 4', () => {
    expect(redactPhone('13147077604')).toBe('131****7604');
    expect(redactPhone('01212744296')).toBe('012****4296');
    expect(redactPhone('+4915560990888')).toBe('+49****0888');
  });

  it('leaves <=6 digit values unmasked (short non-phone values)', () => {
    expect(redactPhone('12345')).toBe('12345');
    expect(redactPhone('123456')).toBe('123456');
  });
});

describe('redactText', () => {
  it('masks contiguous 7+ digit runs in place', () => {
    expect(redactText('自动填写 13147077604')).toBe('自动填写 131****7604');
    expect(redactText('13147077604 和 9097393687')).toBe('131****7604 和 909****3687');
  });

  it('masks the long digit run inside scattered-digit phones (with separators)', () => {
    expect(redactText('+49 155 60990888')).toBe('+49 155 609****0888');
    expect(redactText('电话 +86 0755 12345678')).toBe('电话 +86 0755 123****5678');
  });

  it('returns plain text unchanged', () => {
    expect(redactText('分组外跳过')).toBe('分组外跳过');
    expect(redactText('actions[0]:loop-guard')).toBe('actions[0]:loop-guard');
  });
});
