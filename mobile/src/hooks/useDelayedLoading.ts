import { useEffect, useRef, useState } from 'react'

export function useDelayedLoading(delay = 300): [boolean, (loading: boolean) => void] {
  const [isLoading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateLoading(loading: boolean): void {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (loading && delay > 0) {
      timerRef.current = setTimeout(() => {
        setLoading(true)
        timerRef.current = null
      }, delay)
      return
    }
    setLoading(loading)
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return [isLoading, updateLoading]
}
