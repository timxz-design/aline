import { View } from 'react-native';
import { HealthConnect } from '../../../src/components/HealthConnect';
import { DetailScreen } from '../../../src/components/settings-ui';
import { colors, radius, space } from '../../../src/theme';

export default function HealthScreen() {
  return (
    <DetailScreen
      title="Apple Health"
      subtitle="Workouts you actually did and when you sleep — measured, so nothing needs logging."
    >
      <View style={{ backgroundColor: colors.bgElevated, borderRadius: radius.lg, padding: space.lg }}>
        <HealthConnect />
      </View>
    </DetailScreen>
  );
}
