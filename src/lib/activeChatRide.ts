/**
 * Module-level ref that tracks which rideId the user is actively viewing in ChatScreen.
 * Used by useNotifications to suppress the in-app banner (but keep sound) when
 * the user already has that chat open.
 */
export const activeChatRideId: { current: string | null } = { current: null };
