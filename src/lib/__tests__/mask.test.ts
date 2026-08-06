import { maskEmail, maskPhone, maskName, scrubPII } from '../mask';

describe('maskEmail', () => {
  it('mantém 1ª letra do local-part e o domínio', () => {
    expect(maskEmail('edson@edsonluiz.adv.br')).toBe('e••••@edsonluiz.adv.br');
  });
  it('local-part de 1 char ainda mascara', () => {
    expect(maskEmail('a@x.com')).toBe('a••@x.com');
  });
  it('string sem @ vira •••; vazio continua vazio', () => {
    expect(maskEmail('semarroba')).toBe('•••');
    expect(maskEmail('')).toBe('');
  });
});

describe('maskPhone', () => {
  it('mantém só os 2 últimos dígitos, mascarando o resto', () => {
    const r = maskPhone('+1 (407) 555-1234'); // 11 dígitos
    expect(r).toBe('•'.repeat(9) + '34');
    expect(r.replace(/•/g, '').length).toBe(2);
  });
  it('número curto de 10 dígitos', () => {
    expect(maskPhone('4075551234')).toBe('••••••••34');
  });
  it('ignora formatação e conta só dígitos', () => {
    expect(maskPhone('12')).toBe('••');
    expect(maskPhone('')).toBe('');
  });
});

describe('maskName', () => {
  it('primeiro nome + iniciais dos demais', () => {
    expect(maskName('Maria Silva Souza')).toBe('Maria S. S.');
  });
  it('nome único fica inteiro; vazio continua vazio', () => {
    expect(maskName('Madonna')).toBe('Madonna');
    expect(maskName('   ')).toBe('');
  });
});

describe('scrubPII', () => {
  it('redige chaves sensíveis (segredo puro)', () => {
    const out = scrubPII({ password: 'x', token: 'abc', ssn: '123', card: '4111' });
    expect(out).toEqual({ password: '[redacted]', token: '[redacted]', ssn: '[redacted]', card: '[redacted]' });
  });

  it('mascara PII conhecida por chave', () => {
    const out = scrubPII({ email: 'edson@x.com', phone: '4075551234', full_name: 'Maria Silva' });
    expect(out).toEqual({ email: 'e••••@x.com', phone: '••••••••34', full_name: 'Maria S.' });
  });

  it('redige outras PII (endereço/geo) e recorre em objetos aninhados', () => {
    const out = scrubPII({ user: { address: 'Rua X, 100', lat: 28.5, keep: 'ok' } });
    expect(out).toEqual({ user: { address: '[redacted]', lat: '[redacted]', keep: 'ok' } });
  });

  it('preserva primitivos e valores não sensíveis', () => {
    expect(scrubPII({ rideId: 'r1', amount: 42, ok: true })).toEqual({ rideId: 'r1', amount: 42, ok: true });
  });

  it('reduz Error a name/message (sem stack)', () => {
    const out = scrubPII({ err: new Error('boom') }) as { err: { name: string; message: string } };
    expect(out.err).toEqual({ name: 'Error', message: 'boom' });
  });

  it('corta profundidade excessiva sem quebrar', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    expect(() => scrubPII(deep)).not.toThrow();
    expect(JSON.stringify(scrubPII(deep))).toContain('[depth]');
  });

  it('mascara PII dentro de arrays', () => {
    const out = scrubPII({ contacts: [{ email: 'a@b.com' }, { email: 'c@d.com' }] });
    expect(out).toEqual({ contacts: [{ email: 'a••@b.com' }, { email: 'c••@d.com' }] });
  });
});
