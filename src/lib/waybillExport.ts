// waybillExport — camada fina de exportação do waybill (P4).
//
// Usa módulos nativos (expo-print + expo-sharing), por isso fica SEPARADA do
// núcleo puro em waybill.ts (que é testado em unidade). Aqui só orquestramos:
//   buscar a corrida → ler config → montar (buildWaybill) → HTML (waybillToHtml)
//   → PDF (expo-print) → compartilhar (expo-sharing).
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from './supabase';
import {
  buildWaybill,
  waybillToHtml,
  getWaybillConfig,
  type WaybillLabels,
  type WaybillRideInput,
} from './waybill';

export type WaybillExtras = {
  driverName?: string | null;
  passengerName?: string | null;
  vehicleLabel?: string | null;
  /** Labels traduzidos (i18n) — opcional; default em inglês no núcleo. */
  labels?: Partial<WaybillLabels>;
  jurisdiction?: string;
};

export type WaybillExportResult = { ok: boolean; error?: string; uri?: string };

/**
 * generateAndShareWaybill — gera o PDF do waybill de uma corrida e abre a folha
 * de compartilhamento. Retorna { ok:false, error } de forma silenciosa (sem
 * lançar) para o chamador decidir a UX.
 */
export async function generateAndShareWaybill(
  rideId: string,
  extras: WaybillExtras = {}
): Promise<WaybillExportResult> {
  try {
    const jurisdiction = extras.jurisdiction ?? 'global';
    const { enabled, company } = await getWaybillConfig(jurisdiction);
    if (!enabled) return { ok: false, error: 'disabled' };

    const { data, error } = await supabase
      .from('rides')
      .select(
        'id, price, toll_amount, airport_port_fee, tip_amount, distance_km, duration_min, origin_address, destination_address, created_at, completed_at'
      )
      .eq('id', rideId)
      .single();

    if (error || !data) return { ok: false, error: 'ride_not_found' };

    const ride: WaybillRideInput = {
      ...(data as WaybillRideInput),
      driverName: extras.driverName ?? undefined,
      passengerName: extras.passengerName ?? undefined,
      vehicleLabel: extras.vehicleLabel ?? undefined,
    };

    const html = waybillToHtml(buildWaybill(ride, company, extras.labels ?? {}));
    const { uri } = await Print.printToFileAsync({ html });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    }
    return { ok: true, uri };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}
