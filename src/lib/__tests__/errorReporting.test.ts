import {
  reportError,
  reportWarning,
  addBreadcrumb,
  clearBreadcrumbs,
  setErrorReporter,
  errorMessage,
  type ReportEvent,
} from '../errorReporting';

describe('errorMessage', () => {
  it('extrai mensagem de Error, string e objeto', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('texto')).toBe('texto');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });
});

describe('reportError / reportWarning', () => {
  afterEach(() => {
    setErrorReporter(null);
    clearBreadcrumbs();
    jest.restoreAllMocks();
  });

  it('sempre loga no console (error e warning)', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    reportError(new Error('x'));
    reportWarning(new Error('y'));
    expect(err).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('envia ao sink com contexto já sanitizado (PII removida)', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const events: ReportEvent[] = [];
    setErrorReporter((e) => events.push(e));

    reportError(new Error('falhou'), { email: 'edson@x.com', token: 'secreto', rideId: 'r1' });

    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('error');
    expect(events[0].message).toBe('falhou');
    expect(events[0].context).toEqual({ email: 'e••••@x.com', token: '[redacted]', rideId: 'r1' });
  });

  it('inclui as migalhas (breadcrumbs) sanitizadas no evento', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const events: ReportEvent[] = [];
    setErrorReporter((e) => events.push(e));

    addBreadcrumb('abriu tela', { phone: '4075551234' });
    reportWarning('aviso');

    expect(events[0].breadcrumbs).toHaveLength(1);
    expect(events[0].breadcrumbs[0].data).toEqual({ phone: '••••••••34' });
  });

  it('um sink que lança NUNCA derruba o app', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setErrorReporter(() => { throw new Error('sink quebrado'); });
    expect(() => reportError(new Error('x'))).not.toThrow();
  });
});

describe('addBreadcrumb', () => {
  afterEach(() => { setErrorReporter(null); clearBreadcrumbs(); jest.restoreAllMocks(); });

  it('limita o histórico a 25 migalhas', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const events: ReportEvent[] = [];
    setErrorReporter((e) => events.push(e));
    for (let i = 0; i < 40; i++) addBreadcrumb(`step-${i}`);
    reportError('x');
    expect(events[0].breadcrumbs).toHaveLength(25);
    expect(events[0].breadcrumbs[0].message).toBe('step-15');
  });
});
