import { useEffect, useState } from 'react'
import { Animated, Easing } from 'react-native'
import { useStyles } from '@/hooks/useStyles'

interface LoadingSpinnerProps {
  compact?: boolean
}

export default function LoadingSpinner({ compact = false }: LoadingSpinnerProps) {
  const [rotation] = useState(() => new Animated.Value(0))
  const styles = useStyles((colors) => ({
    spinner: { borderColor: colors.bgStrong, borderBottomColor: colors.primary }
  }))

  useEffect(() => {
    const animation = Animated.loop(Animated.timing(rotation, {
      toValue: 1,
      duration: 800,
      easing: Easing.linear,
      useNativeDriver: true
    }))
    animation.start()

    return () => animation.stop()
  }, [rotation])

  const size = compact ? 16 : 18
  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })

  return <Animated.View style={[styles.spinner, { width: size, height: size, borderWidth: 2, borderRadius: 999, transform: [{ rotate: spin }] }]} />
}
