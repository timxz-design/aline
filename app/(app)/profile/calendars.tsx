import { View } from 'react-native';
import { DeviceCalendarConnect } from '../../../src/components/DeviceCalendarConnect';
import { GoogleCalendarConnect } from '../../../src/components/GoogleCalendarConnect';
import { DetailScreen } from '../../../src/components/settings-ui';
import { colors, radius, space } from '../../../src/theme';

const card = { backgroundColor: colors.bgElevated, borderRadius: radius.lg, padding: space.lg };

export default function CalendarsScreen() {
  return (
    <DetailScreen
      title="Calendars"
      subtitle="ALINE reads when you're busy so plans never clash with what you already have. Read-only."
    >
      {/* Phone calendar first: it's where most people's real schedule lives. */}
      <View style={card}>
        <DeviceCalendarConnect />
      </View>
      <View style={card}>
        <GoogleCalendarConnect />
      </View>
    </DetailScreen>
  );
}
