// Helper mínimo, Deno-only (usa supabase-js — não é o módulo puro
// cross-runtime de telematicsExport.ts), compartilhado pelas Edge Functions
// administrativas do Bloco 2 (admin-telematics-claims, admin-telematics-export)
// para ler uma flag booleana de public.system_config com a mesma resolução
// "jurisdição específica → global" usada em src/lib/systemConfig.ts.
//
// Por que não reaproveitar src/lib/systemConfig.ts diretamente: aquele módulo
// importa `./supabase` (cliente RN, com AsyncStorage/config de app mobile),
// incompatível com o runtime Deno da Edge Function. Duplicar só a resolução
// de jurisdição (não a regra de negócio em si, que mora nas duas flags de
// compliance) evita puxar essa dependência incompatível para cá.

// deno-lint-ignore no-explicit-any
export async function isConfigFlagEnabled(
  admin: any,
  key: string,
  jurisdiction: string = 'global'
): Promise<boolean> {
  const jurisdictions = jurisdiction === 'global' ? ['global'] : [jurisdiction, 'global'];
  const { data } = await admin
    .from('system_config')
    .select('jurisdiction, value')
    .eq('key', key)
    .in('jurisdiction', jurisdictions);

  if (!data || data.length === 0) return false;
  const specific = data.find((r: { jurisdiction: string }) => r.jurisdiction === jurisdiction);
  const global = data.find((r: { jurisdiction: string }) => r.jurisdiction === 'global');
  const row = specific ?? global;
  return row?.value === true;
}
