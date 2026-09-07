import { useEffect, useRef, useState } from 'react'

export function useDelayedLoading(delay = 300, initialIsLoading = false): [boolean, (isLoading: boolean) => void] {
  const [isLoading, setIsLoading] = useState(initialIsLoading)
  const timeoutRef = useRef<number | null>(null)

  function onLoadingChange(nextIsLoading: boolean): void {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (nextIsLoading && delay > 0) {
      timeoutRef.current = window.setTimeout(() => {
        setIsLoading(true)
        timeoutRef.current = null
      }, delay)
      return
    }
    setIsLoading(nextIsLoading)
  }

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
  }, [])

  return [isLoading, onLoadingChange]
}
