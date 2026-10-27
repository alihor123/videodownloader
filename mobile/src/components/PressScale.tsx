import { useState, type PropsWithChildren } from 'react'
import { Animated, Pressable, type StyleProp, type ViewStyle } from 'react-native'

interface PressScaleProps extends PropsWithChildren {
  style: StyleProp<ViewStyle>
  onPress: () => void
  disabled?: boolean
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export default function PressScale({ children, style, onPress, disabled = false }: PressScaleProps) {
  const [scale] = useState(() => new Animated.Value(1))

  function animateTo(value: number) {
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0
    }).start()
  }

  return (
    <AnimatedPressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => animateTo(0.98)}
      onPressOut={() => animateTo(1)}
      style={[style, { opacity: disabled ? 0.72 : 1, transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  )
}
