import { describe, expect, it } from 'vitest';

import { isAccessKeyComplete, isProtocolComplete, normalizeAccessKey, normalizeProtocol, splitLines } from './normalize';

describe('protocolo', () => {
  it.each([
    ['den-2026-a1b2c3', 'DEN-2026-A1B2C3'],
    ['DEN2026A1B2C3', 'DEN-2026-A1B2C3'],
    ['  den 2026 a1b2c3 \n', 'DEN-2026-A1B2C3'],
    ['DEN-2026-A1B2C3\r\n', 'DEN-2026-A1B2C3'],
    ['D E N - 2 0 2 6 - A 1 B 2 C 3', 'DEN-2026-A1B2C3'],
  ])('normaliza %j para %s', (input, expected) => {
    expect(normalizeProtocol(input)).toBe(expected);
    expect(isProtocolComplete(input)).toBe(true);
  });

  it('digitação parcial não é destruída e protocolo incompleto não vale', () => {
    expect(normalizeProtocol('den-20')).toBe('DEN-20');
    expect(normalizeProtocol('DEN-2026-A1')).toBe('DEN-2026-A1');
    expect(isProtocolComplete('DEN-2026-A1')).toBe(false);
    expect(isProtocolComplete('')).toBe(false);
    expect(isProtocolComplete('XYZ-2026-A1B2C3')).toBe(false);
  });
});

describe('chave de acesso', () => {
  it.each([
    ['abcd-efgh-jklm-npqr-stuv', 'ABCD-EFGH-JKLM-NPQR-STUV'],
    ['abcd efgh jklm npqr stuv', 'ABCD-EFGH-JKLM-NPQR-STUV'],
    ['ABCDEFGHJKLMNPQRSTUV', 'ABCD-EFGH-JKLM-NPQR-STUV'],
    ['  ABCD\nEFGH\nJKLM\nNPQR\nSTUV  ', 'ABCD-EFGH-JKLM-NPQR-STUV'],
  ])('agrupa em blocos de 4: %j', (input, expected) => {
    expect(normalizeAccessKey(input)).toBe(expected);
    expect(isAccessKeyComplete(input)).toBe(true);
  });

  it('digitação parcial vira blocos progressivos; curta demais não vale', () => {
    expect(normalizeAccessKey('abcde')).toBe('ABCD-E');
    expect(normalizeAccessKey('')).toBe('');
    expect(isAccessKeyComplete('ABCD-EFGH')).toBe(false);
  });
});

describe('linhas', () => {
  it('uma por linha, sem vazias', () => {
    expect(splitLines('Ana\r\n\n  Beto  \n')).toEqual(['Ana', 'Beto']);
    expect(splitLines('')).toEqual([]);
  });
});
