import { Stack } from 'expo-router';
import { colors } from '../../../src/theme';

/** You tab: a list of rows, each pushing its own detail screen (swipe back). */
export default function YouLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
