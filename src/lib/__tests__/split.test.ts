import { calculateSplit, DEFAULT_DRIVER_SHARE, DRIVER_SHARE, PLATFORM_SHARE } from '../split';

describe('calculateSplit', () => {
  it('usa a fatia padrão (80/20) quando nenhuma é informada', () => {
    const { driverAmount, platformFee } = calculateSplit(100);
    expect(driverAmount).toBe(80);
    expect(platformFee).toBe(20);
  });

  it('aplica a faixa premium (85/15) dos 100 primeiros motoristas', () => {
    const { driverAmount, platformFee } = calculateSplit(100, 0.85);
    expect(driverAmount).toBe(85);
    expect(platformFee).toBe(15);
  });

  it('aplica a faixa padrão (80/20) do 101º motorista em diante', () => {
    const { driverAmount, platformFee } = calculateSplit(100, 0.8);
    expect(driverAmount).toBe(80);
    expect(platformFee).toBe(20);
  });

  it('driverAmount + platformFee sempre reconstitui o total (sem centavo perdido)', () => {
    for (const total of [12.34, 57.89, 103.5, 7.07, 250.01]) {
      for (const share of [0.85, 0.8]) {
        const { driverAmount, platformFee } = calculateSplit(total, share);
        expect(Math.round((driverAmount + platformFee) * 100) / 100).toBe(
          Math.round(total * 100) / 100,
        );
      }
    }
  });

  it('arredonda a fatia do motorista para centavos', () => {
    // 33.33 * 0.85 = 28.3305 → 28.33; plataforma = 33.33 - 28.33 = 5.00
    const { driverAmount, platformFee } = calculateSplit(33.33, 0.85);
    expect(driverAmount).toBe(28.33);
    expect(platformFee).toBe(5);
  });

  it('cai no padrão quando a fatia é inválida (NULL/negativa/>1)', () => {
    // Simula driver_share_percent nulo/corrompido vindo do banco.
    expect(calculateSplit(100, undefined as unknown as number).driverAmount).toBe(80);
    expect(calculateSplit(100, 0).driverAmount).toBe(80);
    expect(calculateSplit(100, -0.5).driverAmount).toBe(80);
    expect(calculateSplit(100, 1.5).driverAmount).toBe(80);
    expect(calculateSplit(100, NaN).driverAmount).toBe(80);
  });

  it('mantém os exports de compatibilidade (fallback de exibição)', () => {
    expect(DEFAULT_DRIVER_SHARE).toBe(0.8);
    expect(DRIVER_SHARE).toBe(0.8);
    expect(PLATFORM_SHARE).toBeCloseTo(0.2, 10);
  });
});
