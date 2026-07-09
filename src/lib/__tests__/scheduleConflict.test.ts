import {
  slotsConflict,
  checkScheduleConflict,
  fallbackTravelMin,
  SCHEDULE_BUFFER_MIN,
  type SchedSlot,
  type RideLike,
  type TravelMinResolver,
} from '../scheduleConflict';

const MIN = 60_000;
const BASE = new Date('2026-07-10T12:00:00Z').getTime();

function slot(offsetMin: number, durationMin: number): SchedSlot {
  return {
    id: `s${offsetMin}`,
    startMs: BASE + offsetMin * MIN,
    durationMin,
    origin: { lat: 0, lng: 0 },
    destination: { lat: 0, lng: 0 },
  };
}

describe('slotsConflict (núcleo puro)', () => {
  it('sem conflito quando há folga suficiente (fim + deslocamento + buffer <= início)', () => {
    const first = slot(0, 30);            // 12:00–12:30
    const second = slot(60, 30);          // 13:00
    // fim 12:30 + 10min deslocamento + 20min folga = 13:00 exatamente → OK
    expect(slotsConflict(first, second, 10, SCHEDULE_BUFFER_MIN)).toBe(false);
  });

  it('conflita quando a segunda começa antes do fim+deslocamento+folga', () => {
    const first = slot(0, 30);            // 12:00–12:30
    const second = slot(55, 30);          // 12:55
    // precisa começar só às 13:00 → 12:55 conflita
    expect(slotsConflict(first, second, 10, SCHEDULE_BUFFER_MIN)).toBe(true);
  });

  it('conflita quando os intervalos das próprias corridas se sobrepõem', () => {
    const first = slot(0, 60);            // 12:00–13:00
    const second = slot(30, 30);          // 12:30 (dentro da primeira)
    expect(slotsConflict(first, second, 0, SCHEDULE_BUFFER_MIN)).toBe(true);
  });

  it('respeita a folga configurável', () => {
    const first = slot(0, 30);            // 12:00–12:30
    const second = slot(45, 30);          // 12:45
    // com buffer 0 e deslocamento 10: precisa 12:40 → 12:45 OK
    expect(slotsConflict(first, second, 10, 0)).toBe(false);
    // com buffer 20: precisa 13:00 → 12:45 conflita
    expect(slotsConflict(first, second, 10, 20)).toBe(true);
  });
});

describe('checkScheduleConflict (orquestrador com resolvedor injetado)', () => {
  const ride = (id: string, offsetMin: number, durationMin: number): RideLike => ({
    id,
    scheduled_for: new Date(BASE + offsetMin * MIN).toISOString(),
    duration_min: durationMin,
    origin_lat: 0,
    origin_lng: 0,
    destination_lat: 0,
    destination_lng: 0,
  });

  // Resolvedor fixo de 10 min de deslocamento, sem rede.
  const fixed: TravelMinResolver = async () => 10;

  it('acusa conflito com corrida imediatamente anterior sem folga', async () => {
    const candidate = ride('novo', 55, 30);      // 12:55
    const existing = [ride('a', 0, 30)];          // 12:00–12:30 → livre só às 13:00
    const r = await checkScheduleConflict(candidate, existing, SCHEDULE_BUFFER_MIN, fixed);
    expect(r.conflict).toBe(true);
    expect(r.withRideId).toBe('a');
  });

  it('não acusa conflito quando há folga de sobra', async () => {
    const candidate = ride('novo', 180, 30);     // 15:00
    const existing = [ride('a', 0, 30)];          // 12:00
    const r = await checkScheduleConflict(candidate, existing, SCHEDULE_BUFFER_MIN, fixed);
    expect(r.conflict).toBe(false);
  });

  it('detecta conflito também quando o novo agendamento é ANTES do existente', async () => {
    const candidate = ride('novo', 0, 30);       // 12:00–12:30
    const existing = [ride('a', 55, 30)];         // 12:55 → precisa 13:00
    const r = await checkScheduleConflict(candidate, existing, SCHEDULE_BUFFER_MIN, fixed);
    expect(r.conflict).toBe(true);
    expect(r.withRideId).toBe('a');
  });

  it('ignora corridas sem horário e a si mesma', async () => {
    const candidate = ride('novo', 55, 30);
    const semData: RideLike = { ...ride('sem', 0, 30), scheduled_for: undefined };
    const eu: RideLike = ride('novo', 0, 30);     // mesmo id → ignorado
    const r = await checkScheduleConflict(candidate, [semData, eu], SCHEDULE_BUFFER_MIN, fixed);
    expect(r.conflict).toBe(false);
  });
});

describe('fallbackTravelMin', () => {
  it('estima ao menos 1 min e cresce com a distância', () => {
    const perto = fallbackTravelMin({ lat: 0, lng: 0 }, { lat: 0, lng: 0 });
    const longe = fallbackTravelMin({ lat: 28.5, lng: -81.4 }, { lat: 28.6, lng: -81.2 });
    expect(perto).toBeGreaterThanOrEqual(1);
    expect(longe).toBeGreaterThan(perto);
  });
});
