import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View, ActivityIndicator, StyleSheet } from 'react-native';

import { RootStackParamList } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useNotifications } from '../hooks/useNotifications';
import { Colors } from '../constants/colors';

import { WelcomeScreen } from '../screens/auth/WelcomeScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { HomeScreen } from '../screens/passenger/HomeScreen';
import { RequestRideScreen } from '../screens/passenger/RequestRideScreen';
import { FindingDriverScreen } from '../screens/passenger/FindingDriverScreen';
import { ActiveRideScreen } from '../screens/passenger/ActiveRideScreen';
import { RateRideScreen } from '../screens/passenger/RateRideScreen';
import { TripHistoryScreen } from '../screens/passenger/TripHistoryScreen';
import { ScheduledRidesScreen } from '../screens/passenger/ScheduledRidesScreen';
import { DriverHomeScreen } from '../screens/driver/DriverHomeScreen';
import { DriverNavigateScreen } from '../screens/driver/DriverNavigateScreen';
import { DriverScheduledRidesScreen } from '../screens/driver/DriverScheduledRidesScreen';
import { EarningsScreen } from '../screens/driver/EarningsScreen';
import { VehicleFormScreen } from '../screens/driver/VehicleFormScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { EditProfileScreen } from '../screens/profile/EditProfileScreen';
import { NotificationSettingsScreen } from '../screens/profile/NotificationSettingsScreen';
import { SupportScreen } from '../screens/profile/SupportScreen';
import { TermsScreen } from '../screens/profile/TermsScreen';
import { PaymentScreen } from '../screens/profile/PaymentScreen';
import { ChatScreen } from '../screens/ChatScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function PassengerTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: Colors.primary, borderTopColor: 'rgba(255,255,255,0.08)', height: 60 },
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.gray[500],
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
      }}
    >
      <Tab.Screen
        name="Início"
        component={HomeScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺</Text> }}
      />
      <Tab.Screen
        name="Viagens"
        component={TripHistoryScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📋</Text> }}
      />
      <Tab.Screen
        name="Perfil"
        component={ProfileScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>👤</Text> }}
      />
    </Tab.Navigator>
  );
}

function DriverTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: Colors.primary, borderTopColor: 'rgba(255,255,255,0.08)', height: 60 },
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.gray[500],
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
      }}
    >
      <Tab.Screen
        name="Mapa"
        component={DriverHomeScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺</Text> }}
      />
      <Tab.Screen
        name="Ganhos"
        component={EarningsScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>💰</Text> }}
      />
      <Tab.Screen
        name="Perfil"
        component={ProfileScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>👤</Text> }}
      />
    </Tab.Navigator>
  );
}

function LoadingScreen() {
  return (
    <View style={styles.loading}>
      <Text style={styles.loadingLogo}>GO<Text style={{ color: Colors.accent }}>XL</Text></Text>
      <ActivityIndicator color={Colors.accent} style={{ marginTop: 24 }} />
    </View>
  );
}

export function AppNavigator() {
  const { session, profile, loading } = useAuth();
  useNotifications(session?.user.id);

  if (loading) return <LoadingScreen />;

  const isAuthenticated = !!session;
  const isDriver = profile?.type === 'driver';

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        {!isAuthenticated ? (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Register" component={RegisterScreen} />
          </>
        ) : isDriver ? (
          <>
            <Stack.Screen name="DriverTabs" component={DriverTabs} />
            <Stack.Screen name="DriverNavigate" component={DriverNavigateScreen} />
            <Stack.Screen name="DriverScheduledRides" component={DriverScheduledRidesScreen} />
            <Stack.Screen name="VehicleForm" component={VehicleFormScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="EditProfile" component={EditProfileScreen} />
            <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
            <Stack.Screen name="Support" component={SupportScreen} />
            <Stack.Screen name="Terms" component={TermsScreen} />
            <Stack.Screen name="Payment" component={PaymentScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="PassengerTabs" component={PassengerTabs} />
            <Stack.Screen name="RequestRide" component={RequestRideScreen} />
            <Stack.Screen name="FindingDriver" component={FindingDriverScreen} />
            <Stack.Screen name="ActiveRide" component={ActiveRideScreen} />
            <Stack.Screen name="RateRide" component={RateRideScreen} />
            <Stack.Screen name="ScheduledRides" component={ScheduledRidesScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="EditProfile" component={EditProfileScreen} />
            <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
            <Stack.Screen name="Support" component={SupportScreen} />
            <Stack.Screen name="Terms" component={TermsScreen} />
            <Stack.Screen name="Payment" component={PaymentScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingLogo: {
    fontSize: 64,
    fontWeight: '900',
    color: Colors.white,
    letterSpacing: -2,
  },
});
