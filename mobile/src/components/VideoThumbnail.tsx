import { useState } from 'react'
import { View } from 'react-native'
import { Image } from 'expo-image'
import { useStyles } from '@/hooks/useStyles'
import ThumbnailSkeleton from './ThumbnailSkeleton'

interface VideoThumbnailProps {
  src: string
  height: number
  maxWidth: number
  borderRadius: number
}

export default function VideoThumbnail({ src, height, maxWidth, borderRadius }: VideoThumbnailProps) {
  const [image, setImage] = useState({ status: 'loading', ratio: 16 / 9 })
  const width = Math.min(maxWidth, height * image.ratio)
  const styles = useStyles((colors) => ({
    frame: { position: 'relative' as const, width, height, borderRadius, overflow: 'hidden' as const, backgroundColor: colors.bgMuted },
    image: { position: 'absolute' as const, width, height, opacity: image.status === 'loaded' ? 1 : 0 }
  }))

  if (image.status === 'error') return null

  return (
    <View style={styles.frame}>
      {image.status === 'loading' && <ThumbnailSkeleton width={width} height={height} borderRadius={borderRadius} />}
      <Image
        source={{ uri: src }}
        style={styles.image}
        contentFit="contain"
        onLoad={({ source }) => setImage({ status: 'loaded', ratio: source.height > 0 ? source.width / source.height : 16 / 9 })}
        onError={() => setImage({ ...image, status: 'error' })}
      />
    </View>
  )
}
