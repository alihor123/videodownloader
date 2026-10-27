import { Colors } from '@/constants/colors'
import { StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'

export function useStyles<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(createStyles: (colors: typeof Colors.light) => T) {
  const theme = useColorScheme()
  const colors = theme === 'dark' ? Colors.dark : Colors.light

  return StyleSheet.create(createStyles(colors))
}
