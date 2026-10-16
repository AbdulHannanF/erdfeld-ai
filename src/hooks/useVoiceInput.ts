'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

/** The slice of the Web Speech API this uses (it is not in the DOM typings in every browser). */
interface SpeechResult { isFinal: boolean; 0: { transcript: string } }
interface SpeechEvent { resultIndex: number; results: ArrayLike<SpeechResult> }
interface Recognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((e: SpeechEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as (new () => Recognition) | null
}

/**
 * Dictate into a text field. Final phrases are appended to the text that was there when recording
 * started; the phrase still being recognised is returned as `interim` so it can be shown but is
 * not yet part of the value. Ctrl+M toggles it. Unsupported browsers get a toast, not a dead button.
 */
export function useVoiceInput(value: string, onChange: (v: string) => void) {
  const [recording, setRecording] = useState(false)
  const [interim, setInterim] = useState('')
  const ref = useRef<Recognition | null>(null)

  const toggle = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      toast.error('Voice input is not supported in this browser')
      return
    }
    if (recording && ref.current) {
      ref.current.stop()
      return
    }
    const r = new Ctor()
    r.continuous = true
    r.interimResults = true
    r.lang = 'en-US'
    let text = value
    r.onresult = (e) => {
      let partial = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) {
          text += (text ? ' ' : '') + res[0].transcript.trim()
          onChange(text)
        } else partial += res[0].transcript
      }
      setInterim(partial)
    }
    r.onerror = (e) => {
      if (e.error !== 'aborted') toast.error(`Voice input error: ${e.error}`)
      setRecording(false)
      setInterim('')
    }
    r.onend = () => {
      setRecording(false)
      setInterim('')
    }
    ref.current = r
    r.start()
    setRecording(true)
  }, [recording, value, onChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  useEffect(() => () => ref.current?.stop(), [])

  return { recording, interim, toggle, supported: typeof window !== 'undefined' && !!recognitionCtor() }
}
