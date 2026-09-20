import { describe, expect, it } from 'vitest';

import { buildPayload, checkFile, EMPTY_FORM, validateComplaint, type ComplaintFormValues } from './validation';

// Tradução de teste: devolve a própria chave, o que prova que os textos vêm do dicionário (nunca da biblioteca).
const t = (k: string) => `T:${k}`;

const valid: ComplaintFormValues = {
  type: 'FRAUD',
  title: 'Suspeita de fraude em notas',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais.',
  incidentDate: '2026-03-10',
  location: 'Setor financeiro',
  department: '',
  involvedPeople: 'João Silva\nMaria Souza',
  witnesses: '',
  contentWarningAcknowledged: true,
};

describe('validateComplaint', () => {
  it('formulário completo não tem erros', () => {
    expect(validateComplaint(valid, t, new Date('2026-09-20'))).toEqual({});
  });

  it('formulário vazio acusa os campos obrigatórios com textos do dicionário', () => {
    const e = validateComplaint(EMPTY_FORM, t);
    expect(e).toEqual({
      type: 'T:type',
      title: 'T:title',
      description: 'T:description',
      involvedPeople: 'T:involved',
      contentWarningAcknowledged: 'T:ack',
    });
  });

  it('mesmas regras da API: título 10–200, descrição ≥ 50, ao menos um citado', () => {
    expect(validateComplaint({ ...valid, title: 'curto' }, t).title).toBe('T:title');
    expect(validateComplaint({ ...valid, title: 'x'.repeat(201) }, t).title).toBe('T:title');
    expect(validateComplaint({ ...valid, description: 'x'.repeat(49) }, t).description).toBe('T:description');
    expect(validateComplaint({ ...valid, description: 'x'.repeat(20_001) }, t).description).toBe('T:descriptionMax');
    expect(validateComplaint({ ...valid, involvedPeople: '  \n ' }, t).involvedPeople).toBe('T:involved');
  });

  it('data: futura e formato inválido têm mensagens diferentes; vazia é aceita', () => {
    const now = new Date('2026-09-20T12:00:00');
    expect(validateComplaint({ ...valid, incidentDate: '2026-09-21' }, t, now).incidentDate).toBe('T:incidentDateFuture');
    expect(validateComplaint({ ...valid, incidentDate: '20/09/2026' }, t, now).incidentDate).toBe('T:incidentDateFormat');
    expect(validateComplaint({ ...valid, incidentDate: '2026-09-20' }, t, now).incidentDate).toBeUndefined();
    expect(validateComplaint({ ...valid, incidentDate: '' }, t, now).incidentDate).toBeUndefined();
  });

  it('o aviso de identificação por conteúdo é obrigatório no relato anônimo', () => {
    expect(validateComplaint({ ...valid, contentWarningAcknowledged: false }, t).contentWarningAcknowledged).toBe('T:ack');
  });
});

describe('buildPayload', () => {
  it('omite vazios, apara espaços e separa listas por linha; é sempre anônimo', () => {
    expect(buildPayload({ ...valid, location: '  ', department: '', witnesses: ' Ana \n\nBeto ' })).toEqual({
      isAnonymous: true,
      contentWarningAcknowledged: true,
      type: 'FRAUD',
      title: 'Suspeita de fraude em notas',
      description: valid.description,
      incidentDate: '2026-03-10',
      location: undefined,
      department: undefined,
      involvedPeople: ['João Silva', 'Maria Souza'],
      witnesses: ['Ana', 'Beto'],
    });
  });
});

describe('checkFile', () => {
  it('aceita os formatos permitidos e recusa o resto e o que passa de 25 MB', () => {
    expect(checkFile({ name: 'a.PDF', size: 10 })).toBe('ok');
    expect(checkFile({ name: 'foto.jpeg', size: 10 })).toBe('ok');
    expect(checkFile({ name: 'virus.exe', size: 10 })).toBe('bad_type');
    expect(checkFile({ name: 'semextensao', size: 10 })).toBe('bad_type');
    expect(checkFile({ name: 'grande.zip', size: 25 * 1024 * 1024 + 1 })).toBe('too_big');
    expect(checkFile({ name: 'limite.zip', size: 25 * 1024 * 1024 })).toBe('ok');
    expect(checkFile({ name: 'a.doc', size: 10 })).toBe('ok');
    expect(checkFile({ name: 'a.doc', size: 10 }, { anonymous: true })).toBe('doc_anonymous'); // não dá para limpar metadados
    expect(checkFile({ name: 'a.docx', size: 10 }, { anonymous: true })).toBe('ok');
  });
});
