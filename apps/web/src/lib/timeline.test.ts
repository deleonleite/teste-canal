import { describe, expect, it } from 'vitest';

import { approxParts, buildMilestones } from './timeline';

const at = (d: string) => `2026-09-${d}T14:00:00.000Z`;

describe('marcos da linha do tempo pública', () => {
  it('relato novo: só o primeiro marco está no presente', () => {
    const m = buildMilestones([{ status: 'PENDING', at: at('10') }], 'PENDING');
    expect(m.map((x) => x.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
    expect(m[0]!.at).toBe(at('10'));
    expect(m[1]!.at).toBeNull();
  });

  it('em investigação: o anterior está concluído', () => {
    const m = buildMilestones([{ status: 'PENDING', at: at('10') }, { status: 'IN_PROGRESS', at: at('11') }], 'IN_PROGRESS');
    expect(m.map((x) => x.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(m[1]!.at).toBe(at('11'));
  });

  it('escalada aparece como "em análise" (jargão interno não vai ao denunciante)', () => {
    const m = buildMilestones([{ status: 'PENDING', at: at('10') }, { status: 'ESCALATED', at: at('12') }], 'ESCALATED');
    expect(m.map((x) => x.state)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('só mostra progresso: voltar de status internamente não retrocede o denunciante', () => {
    const m = buildMilestones(
      [{ status: 'PENDING', at: at('10') }, { status: 'UNDER_REVIEW', at: at('12') }, { status: 'IN_PROGRESS', at: at('13') }],
      'IN_PROGRESS',
    );
    expect(m.map((x) => x.state)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('encerrado (resolvida ou arquivada): todos os marcos concluídos', () => {
    for (const final of ['RESOLVED', 'DISMISSED']) {
      const m = buildMilestones([{ status: 'PENDING', at: at('10') }, { status: final, at: at('15') }], final);
      expect(m.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done']);
      expect(m[3]!.at).toBe(at('15'));
    }
  });
});

describe('data aproximada', () => {
  it('data por extenso e só a hora cheia', () => {
    const p = approxParts('2026-09-12T14:00:00', 'pt');
    expect(p.date).toBe('12 de setembro de 2026');
    expect(p.hour).toBe(14);
  });
});
