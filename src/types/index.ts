export type UserType = 'passenger' | 'driver';

export type RideStatus =
  | 'scheduled'
  | 'requesting'
  | 'accepted'
  | 'driver_en_route'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface Profile {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  type: UserType;
  avatar_url?: string;
  /** Idioma preferido: 'en' | 'es' | 'pt'. */
  language?: string;
  rating?: number;
  total_rides?: number;
  push_token?: string;
  driver_code?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  // Verificação de identidade do motorista (selfie + documento)
  verification_selfie_url?: string;
  verification_document_url?: string;
  verification_status?: 'unsubmitted' | 'pending' | 'approved' | 'rejected' | 'revoked';
  verification_notes?: string;
  verification_submitted_at?: string;
  is_admin?: boolean;
  /**
   * Região usada pelo rollout gradual de feature flags (ver system_config /
   * getConfig em src/lib/systemConfig.ts). 'global' por padrão — só o
   * backend (service_role/admin) pode alterar (migration 0055 trava
   * auto-edição pelo próprio usuário).
   */
  jurisdiction?: string;
  created_at: string;
  // Pagamento Stripe (passageiro)
  stripe_customer_id?: string;
  stripe_payment_method_id?: string;
  card_last4?: string;
  card_brand?: string;
  // Stripe Connect (motorista parceiro)
  stripe_account_id?: string;
  stripe_onboarding_complete?: boolean;
  stripe_charges_enabled?: boolean;
  stripe_payouts_enabled?: boolean;
  /** Fatia do motorista fixada no onboarding: 0.85 (100 primeiros) ou 0.80. */
  driver_share_percent?: number;
  /** Ordem de conclusão do onboarding (auditoria de faixa). */
  driver_onboarded_seq?: number;
  // Compartilhar viagem ao vivo (Tarefa 1) — quando ON, o app oferece, em um
  // toque, abrir o share sheet para o contato escolhido ao iniciar a corrida.
  // NUNCA envia sozinho (o share sheet exige a ação do passageiro).
  trip_autoshare?: boolean;
  trip_autoshare_contact_id?: string | null;
}

// Contato de confiança para compartilhamento de viagem (Tarefa 1). O rótulo
// `contact` (telefone/e-mail) serve só para o passageiro reconhecer o contato
// na lista — NÃO é usado para envio automático.
export interface TrustedContact {
  id: string;
  owner_id: string;
  name: string;
  contact?: string | null;
  created_at: string;
}

export interface Vehicle {
  id: string;
  driver_id: string;
  model: string;
  plate: string;
  color: string;
  year: number;
}

export interface DriverLocation {
  driver_id: string;
  lat: number;
  lng: number;
  heading?: number;
  is_online: boolean;
  updated_at: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
  heading?: number;
  /** Velocidade instantânea do GPS, em m/s (undefined quando o dispositivo não informa). */
  speed?: number;
}

export interface Location extends Coordinates {
  address: string;
}

export interface Ride {
  id: string;
  passenger_id: string;
  driver_id?: string;
  // Objetos aninhados (vêm da view rides_with_locations)
  origin?: Location;
  destination?: Location;
  // Campos planos (vêm da tabela rides via realtime/insert/update)
  origin_lat?: number;
  origin_lng?: number;
  origin_address?: string;
  destination_lat?: number;
  destination_lng?: number;
  destination_address?: string;
  status: RideStatus;
  price?: number;
  distance_km?: number;
  duration_min?: number;
  toll_amount?: number;
  airport_port_fee?: number;
  scheduled_for?: string;
  // Telemetria ao vivo do motorista (posição + ETA até o alvo atual)
  driver_lat?: number;
  driver_lng?: number;
  driver_heading?: number;
  driver_eta_min?: number;
  driver_eta_km?: number;
  // Bloco 3 (paridade Uber): ROTA ÚNICA calculada no servidor (Edge Function
  // compute-route → RPC commit_ride_route). Motorista e passageiro leem estas
  // colunas → veem exatamente a mesma rota/ETA. route_version incrementa a cada
  // recálculo (reroute). Ver migration 0061 e src/lib/nav/sharedRoute.ts.
  route_polyline?: string;
  route_version?: number;
  route_eta_min?: number;
  route_distance_km?: number;
  route_updated_at?: string;
  created_at: string;
  accepted_at?: string;
  /** Bloco 1 (compliance TNC): marco P2→P3, carimbado pelo servidor (ver migration 0056). */
  boarded_at?: string;
  /** Bloco 4 (compliance TNC): passageiro confirmou motorista+veículo antes do embarque (ver migration 0060). */
  passenger_confirmed_driver_at?: string;
  completed_at?: string;
  /** Bloco 1 (compliance TNC): carimbado pelo servidor quando status vira 'cancelled'. */
  cancelled_at?: string;
  paid?: boolean;
  stripe_payment_intent_id?: string;
  tip_amount?: number;
  passenger?: Profile;
  // Nome do passageiro (join client-side em profiles.full_name — não vem da
  // tabela rides nem da view rides_with_locations). Usado nos cards de
  // agendamento para o motorista saber quem solicitou.
  passenger_name?: string | null;
  // Foto e avaliação média do passageiro (join client-side em profiles) — usados
  // nos cards/telas do motorista para identificar quem solicitou a corrida.
  passenger_avatar_url?: string | null;
  passenger_rating?: number | null;
  driver?: Profile;
  vehicle?: Vehicle;
}

export interface RideRecord {
  id: string;
  passenger_id: string;
  driver_id?: string;
  origin_lat: number;
  origin_lng: number;
  origin_address: string;
  destination_lat: number;
  destination_lng: number;
  destination_address: string;
  status: RideStatus;
  price?: number;
  distance_km?: number;
  duration_min?: number;
  scheduled_for?: string;
  paid?: boolean;
  created_at: string;
  accepted_at?: string;
  completed_at?: string;
  // Nome do passageiro — preenchido client-side via join em profiles
  // (ver useDriverScheduledRides.refresh). Ver comentário em Ride acima.
  passenger_name?: string | null;
  // Foto e avaliação média do passageiro (mesmo join client-side).
  passenger_avatar_url?: string | null;
  passenger_rating?: number | null;
}

export interface RideRequest {
  origin: Location;
  destination: Location;
  estimated_price: number;
  estimated_distance_km: number;
  estimated_duration_min: number;
}

export type RootStackParamList = {
  Welcome: undefined;
  Login: undefined;
  ForgotPassword: undefined;
  ResetPassword: undefined;
  Register: { type: UserType };
  ExpressRegister: { driverCode: string };
  AddCardOnboarding: undefined;
  CompleteRegistration: undefined;
  PassengerTabs: undefined;
  DriverTabs: undefined;
  RequestRide: { destination?: Location; lockedDriverId?: string; lockedDriverName?: string; express?: boolean };
  QRCode: undefined;
  FindingDriver: { ride: Ride };
  ActiveRide: { ride: Ride };
  RateRide: { ride: Ride };
  DriverRequest: { ride: Ride };
  DriverNavigate: { ride: Ride; initialDriverLocation?: { lat: number; lng: number } };
  VehicleForm: undefined;
  DriverVerification: undefined;
  // Compliance TNC (F.S. 627.748, Bloco 1): resumo de cobertura de seguro por
  // período P0-P3, nos mesmos moldes da tela "Insurance" do app do motorista
  // da Uber (ver docs/bloco1-compliance-periodos.md).
  Insurance: undefined;
  // Compliance TNC (F.S. 627.748, Bloco 3): termo de divulgação legal do
  // motorista — aceite gravado em driver_disclosure_acceptances (migration
  // 0059). Mesmos moldes de navegação da tela "Insurance" (Bloco 1).
  Disclosure: undefined;
  EditProfile: undefined;
  NotificationSettings: undefined;
  Support: undefined;
  Terms: undefined;
  Payment: undefined;
  TripDetails: { ride: RideRecord };
  ScheduledRides: undefined;
  DriverScheduledRides: undefined;
  TrustedContacts: undefined;
  Chat: { rideId: string; title: string };
  // Rastreio público de viagem ao vivo (deep link goxl.app/track?token=…).
  // Acessível SEM login — o contato de confiança abre pelo link recebido.
  TrackTrip: { token: string };
};

export interface Message {
  id: string;
  ride_id: string;
  sender_id: string;
  text: string;
  created_at: string;
}
