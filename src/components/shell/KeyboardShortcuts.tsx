'use client'

import { useEffect, useCallback } from 'react'
import { useStore } from '@/store/useStore'

export default function KeyboardShortcuts() {
  const showShortcuts = useStore((s) => s.showShortcuts)
  const setShowShortcuts = useStore((s) => s.setShowShortcuts)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Escape - cancel/close
      if (e.key === 'Escape') {
        if (showShortcuts) {
          setShowShortcuts(false)
          return
        }
        // Close any open panels / panels handle their own Escape via their own listeners
        return
      }

      // Ctrl+K - Open command palette (was: focus geocoding search)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
        return
      }

      // Ctrl+Enter - Send chat message
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        const chatInput = document.querySelector<HTMLTextAreaElement>('#chat-input')
        if (chatInput) {
          // Trigger the send by dispatching a custom event
          window.dispatchEvent(new CustomEvent('send-chat-message'))
        }
        return
      }

      // F - Toggle fullscreen (only when not typing in an input)
      if (
        e.key === 'f' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        const target = e.target as HTMLElement
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return
        }
        e.preventDefault()
        // Toggle fullscreen on the map container
        const mapContainer = document.querySelector('[data-map-container]') as HTMLElement
        if (mapContainer) {
          if (document.fullscreenElement) {
            document.exitFullscreen()
          } else {
            mapContainer.requestFullscreen()
          }
        }
        return
      }
    },
    [showShortcuts, setShowShortcuts, setCommandPaletteOpen],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Headless — keyboard events only, button lives in MapToolbar
  return null
}
