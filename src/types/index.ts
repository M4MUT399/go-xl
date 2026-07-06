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
  created_at: string;
  // Pagamento Stripe
  stripe_customer_id?: string;
  stripe_payment_method_id?: string;
  card_last4?: string;
  card_brand?: string;
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
  created_at: string;
  accepted_at?: string;
  completed_at?: string;
  paid?: boolean;
  stripe_payment_intent_id?: string;
  tip_amount?: number;
  passenger?: Profile;
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
  EditProfile: undefined;
  NotificationSettings: undefined;
  Support: undefined;
  Terms: undefined;
  Payment: undefined;
  ScheduledRides: undefined;
  DriverScheduledRides: undefined;
  Chat: { rideId: string; title: string };
};

export interface Message {
  id: string;
  ride_id: string;
  sender_id: string;
  text: string;
  created_at: string;
}
