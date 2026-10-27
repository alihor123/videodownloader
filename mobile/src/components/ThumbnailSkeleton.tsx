import { useEffect, useState } from 'react'
import { Animated, type ViewStyle } from 'react-native'
import { useStyles } from '@/hooks/useStyles'

interface ThumbnailSkeletonProps {
  width: number
  height: number
  borderRadius: number
}

export default function ThumbnailSkeleton({ width, height, borderRadius }: ThumbnailSkeletonProps) {
  const [opacity] = useState(() => new Animated.Value(0.45))
  const styles = useStyles((colors) => ({
    skeleton: { width, height, borderRadius, backgroundColor: colors.bgStrong } as ViewStyle
  }))

  useEffect(() => {
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 575, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.45, duration: 575, useNativeDriver: true })
    ]))
    animation.start()

    return () => animation.stop()
  }, [opacity])

  return <Animated.View style={[styles.skeleton, { opacity }]} />
}
