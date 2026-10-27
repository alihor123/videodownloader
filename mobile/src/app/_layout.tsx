import { useFonts } from 'expo-font'
import { Slot } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require('../../assets/fonts/Inter.ttf'),
    Archivo: require('../../assets/fonts/Archivo.ttf')
  })

  if (!fontsLoaded && !fontError) return null

  return (
    <>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Slot />
      </SafeAreaProvider>
    </>
  )
}
