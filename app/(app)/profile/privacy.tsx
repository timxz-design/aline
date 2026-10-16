import { Ionicons } from '@expo/vector-icons';
import { Alert } from 'react-native';
import { DetailScreen, Group, Row } from '../../../src/components/settings-ui';
import { useAuth } from '../../../src/lib/auth-context';
import { OPENNESS_OPTIONS, type SocialOpenness } from '../../../src/lib/onboarding-data';
import { supabase } from '../../../src/lib/supabase';
import { useProfile } from '../../../src/lib/use-profile';
import { colors } from '../../../src/theme';

export default function PrivacyScreen() {
  const { user } = useAuth();
  const { profile, refresh } = useProfile();

  const choose = async (value: SocialOpenness) => {
    if (!user || profile?.social_openness === value) return;
    const { error } = await supabase.from('profiles').update({ social_openness: value }).eq('id', user.id);
    if (error) Alert.alert("Couldn't save", error.message);
    else refresh();
  };

  return (
    <DetailScreen
      title="Who can plan with you"
      subtitle="Decides who ALINE coordinates with on your behalf."
    >
      <Group footer="Friends' agents see when you're free or busy. Inner-circle friends (starred in Friends) see your full schedule.">
        {OPENNESS_OPTIONS.map((o) => (
          <Row
            key={o.value}
            title={o.label}
            subtitle={o.description}
            onPress={() => choose(o.value)}
            chevron={false}
            right={
              profile?.social_openness === o.value ? (
                <Ionicons name="checkmark" size={20} color={colors.accent} />
              ) : undefined
            }
          />
        ))}
      </Group>
    </DetailScreen>
  );
}
