import { Text, View, useWindowDimensions } from 'react-native'
import { useStyles } from '@/hooks/useStyles'

export default function Header() {
  const { width } = useWindowDimensions()
  const isSmallPhone = width <= 520
  const isCompact = width <= 900
  const styles = useStyles((colors) => ({
    header: { alignItems: 'flex-start' as const, paddingHorizontal: isCompact ? 2 : 0, paddingTop: 0, paddingBottom: isCompact ? 8 : 10, gap: isCompact ? 4 : 5 },
    brandRow: { flexDirection: 'row' as const, alignItems: 'center' as const, width: '100%' as const },
    brand: { color: colors.text, fontFamily: 'Archivo', fontSize: isSmallPhone ? 21 : isCompact ? 24 : 30, lineHeight: isSmallPhone ? 21 : isCompact ? 24 : 30, fontWeight: '800' as const },
    accent: { color: colors.primary },
    beta: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isSmallPhone ? 16 : isCompact ? 19 : 25, lineHeight: isSmallPhone ? 16 : isCompact ? 19 : 25, fontWeight: '500' as const, marginLeft: 'auto' as const },
    subtitle: { color: colors.textSecondary, fontFamily: 'Inter', fontSize: isSmallPhone ? 13 : isCompact ? 14 : 15, lineHeight: isSmallPhone ? 16.25 : isCompact ? 17.5 : 15 }
  }))

  return (
    <View style={styles.header}>
      <View style={styles.brandRow}>
        <Text style={styles.brand}>a4</Text>
        <Text style={[styles.brand, styles.accent]}>loader</Text>
        <Text style={styles.beta}>BETA</Text>
      </View>
      <Text style={styles.subtitle}>Любимые видео под рукой</Text>
    </View>
  )
}
