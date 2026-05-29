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
  rating?: number;
  total_rides?: number;
  push_token?: string;
  created_at: string;
}

export interface Vehicle {
  id: string;
  driver_id: string;
  model: string;
  plate: string;
  color: string;
  year: number;
  photo_url?: string;
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
}

export interface Location extends Coordinates {
  address: string;
}

export interface Ride {
  id: string;
  passenger_id: string;
  driver_id?: string;
  origin: Location;
  destination: Location;
  status: RideStatus;
  price?: number;
  distance_km?: number;
  duration_min?: number;
  scheduled_for?: string;
  created_at: string;
  accepted_at?: string;
  completed_at?: string;
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
  Register: { type: UserType };
  PassengerTabs: undefined;
  DriverTabs: undefined;
  RequestRide: { destination: Location };
  FindingDriver: { ride: Ride };
  ActiveRide: { ride: Ride };
  RateRide: { ride: Ride };
  DriverRequest: { ride: Ride };
  DriverNavigate: { ride: Ride };
  VehicleForm: undefined;
  EditProfile: undefined;
  NotificationSettings: undefined;
  Support: undefined;
  Terms: undefined;
  Payment: undefined;
  ScheduledRides: undefined;
  Chat: { rideId: string; title: string };
};

export interface Message {
  id: string;
  ride_id: string;
  sender_id: string;
  text: string;
  created_at: string;
}
