import { describe, it, expect } from 'vitest';
import { parseAmount, formatAmount } from '@/lib/money';
describe('integer-only token amounts', () => {
  it('preserves smallest units without floating point', () => {
    expect(parseAmount('0.000001')).toBe(1n);
    expect(parseAmount('999.999999')).toBe(999999999n);
    expect(formatAmount(999999999n)).toBe('999.999999');
  });
  it.each(['0', '-1', '1e2', 'NaN', 'Infinity', '1.0000001', ' 5', '01', '1000.000001', '0x10'])(
    'rejects unsafe input %s',
    (input) => expect(() => parseAmount(input)).toThrow(),
  );
  it('formats credits, debits and zero', () => {
    expect(formatAmount('-5000000')).toBe('-5');
    expect(formatAmount('0')).toBe('0');
  });
});
