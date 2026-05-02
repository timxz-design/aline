import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type ViewStyle,
} from 'react-native';
import { colors, radius, space } from '../theme';

type Variant = 'primary' | 'secondary' | 'ghost';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
} & Pick<PressableProps, 'hitSlop'>;

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
  hitSlop,
}: Props) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant].base,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variantStyles[variant].textColor} size="small" />
      ) : (
        <Text style={[styles.label, { color: variantStyles[variant].textColor }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.45 },
});

const variantStyles = {
  primary: {
    base: { backgroundColor: colors.accent },
    textColor: colors.textInverse,
  },
  secondary: {
    base: {
      backgroundColor: colors.bgRaised,
      borderWidth: 1,
      borderColor: colors.border,
    },
    textColor: colors.text,
  },
  ghost: {
    base: { backgroundColor: 'transparent' },
    textColor: colors.accent,
  },
} as const;
