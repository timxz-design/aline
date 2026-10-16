import Constants from 'expo-constants';
import { Alert, Text, View } from 'react-native';
import { PersonAvatar } from '../../../src/components/PersonAvatar';
import { PipelineStatus } from '../../../src/components/PipelineStatus';
import { DetailScreen, Group, Row } from '../../../src/components/settings-ui';
import { useAuth } from '../../../src/lib/auth-context';
import { supabase } from '../../../src/lib/supabase';
import { useProfile } from '../../../src/lib/use-profile';
import { colors, space } from '../../../src/theme';

export default function AccountScreen() {
  const { user, signOut } = useAuth();
  const { profile, refresh } = useProfile();

  const editName = () =>
    Alert.prompt(
      'Your name',
      'How friends see you in ALINE.',
      async (text) => {
        const name = text?.trim();
        if (!user || !name) return;
        const { error } = await supabase.from('profiles').update({ first_name: name }).eq('id', user.id);
        if (error) Alert.alert("Couldn't save", error.message);
        else refresh();
      },
      'plain-text',
      profile?.first_name ?? '',
    );

  const confirmSignOut = () =>
    Alert.alert('Sign out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ]);

  const version = Constants.expoConfig?.version;
  const build = Constants.expoConfig?.ios?.buildNumber;

  return (
    <DetailScreen title="Account">
      <View style={{ alignItems: 'center', gap: space.xs }}>
        <PersonAvatar id={user?.id} name={profile?.first_name} size={72} />
      </View>

      <Group>
        <Row title="Name" value={profile?.first_name ?? 'Add'} onPress={editName} />
        <Row title="Handle" value={profile?.handle ? `@${profile.handle}` : '—'} />
        <Row title="Email" value={user?.email ?? '—'} />
      </Group>

      <Group label="Behind the scenes">
        <View style={{ padding: space.md }}>
          <PipelineStatus />
        </View>
      </Group>

      <Group>
        <Row title="Sign out" onPress={confirmSignOut} chevron={false} />
      </Group>

      <Text style={{ textAlign: 'center', color: colors.textDim, fontSize: 11 }}>
        ALINE {version ?? ''}{build ? ` (${build})` : ''} · alpha
      </Text>
    </DetailScreen>
  );
}
