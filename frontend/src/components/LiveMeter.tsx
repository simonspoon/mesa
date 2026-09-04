import { useEffect, useRef, useState } from 'react'
import { smoothLevel } from '../liveBand'
import { emptyMeterHistory, METER_FRAMES_PER_BAR, pushMeterHistory } from '../liveHead'

/**
 * The head's level meter (mesa task 1069): twelve bars of how loud this room
 * has been, newest on the right.
 *
 * It replaces the single fill bar that used to sit beside the listen switch,
 * and it answers the same question that one did — a one-shot transcription has
 * no partial result to show mid-segment, so the meter is the auris path's only
 * sign the microphone is doing anything at all. A *history* rather than a
 * level because the head is read at a glance: one bar rising and falling says
 * "something", twelve say whether the last second was a sentence or a cough.
 *
 * Its own component, and its own state, for `LiveBand`'s reason: the row
 * advances twelve times a second, and `LiveHub` is not a tree to re-render at
 * that rate. Everything the loop reads lives in a ref; the only state is the
 * finished row, written on the frames that actually change it
 * (`pushMeterHistory` hands back the same array on the other four in five).
 */
export function LiveMeter({ level }: { level: number }) {
  const [history, setHistory] = useState(emptyMeterHistory)
  const historyRef = useRef(history)
  const levelRef = useRef(level)
  // The loudest frame since the last bar landed: a bar stands for five frames,
  // and sampling only the fifth would drop the peak of a syllable four times
  // out of five.
  const peakRef = useRef(0)
  const smoothedRef = useRef(0)

  useEffect(() => {
    levelRef.current = level
  }, [level])

  useEffect(() => {
    let raf = 0
    let tick = 0
    const frame = (): void => {
      smoothedRef.current = smoothLevel(smoothedRef.current, levelRef.current)
      peakRef.current = Math.max(peakRef.current, smoothedRef.current)
      const next = pushMeterHistory(historyRef.current, peakRef.current, tick)
      tick = (tick + 1) % METER_FRAMES_PER_BAR
      if (next !== historyRef.current) {
        historyRef.current = next
        peakRef.current = 0
        setHistory(next)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // Mount/unmount only: a fresh level reaches the loop through the ref.
  }, [])

  return (
    // Decoration for the eye, exactly as the fill bar it replaces was: the
    // capture hint under the box is what reports the microphone to a screen
    // reader.
    <div className="live-meter" aria-hidden="true">
      {history.map((bar, index) => (
        <span
          key={index}
          className="live-meter-bar"
          // The same curve the old fill bar used, so a room that read as half
          // full still does: a raw RMS is far too quiet to see.
          style={{
            height: `${Math.max(2, Math.min(1, Math.sqrt(bar) * 3) * 18)}px`,
          }}
        />
      ))}
    </div>
  )
}
