import * as React from "react"

const MOBILE_BREAKPOINT = 768

function subscribeToMobileViewport(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

function getMobileViewportSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getMobileViewportServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeToMobileViewport,
    getMobileViewportSnapshot,
    getMobileViewportServerSnapshot
  )
}
