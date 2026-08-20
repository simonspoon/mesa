import { describe, expect, it } from 'vitest'
import { isLive, liveControls, liveStatusLine } from './liveSession'
import type { LiveSession } from './types/LiveSession'

function session(patch: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 1,
    project_id: null,
    agent_id: 'a1b2c3',
    status: 'live',
    route: '#/live',
    context: null,
    started_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ended_at: null,
    working_since: null,
    ...patch,
  }
}

describe('isLive', () => {
  it('is only true for a running conversation', () => {
    expect(isLive(session())).toBe(true)
    // The ended row is kept — its transcript is still on screen — so its
    // presence says nothing on its own.
    expect(isLive(session({ status: 'ended' }))).toBe(false)
    expect(isLive(null)).toBe(false)
  })
})

describe('liveControls', () => {
  it('offers to start when nothing is running', () => {
    // Not live, so audio being locked changes nothing: the press that starts
    // the conversation is the gesture that unlocks it.
    for (const unlocked of [false, true]) {
      expect(liveControls(null, null, unlocked, false)).toEqual({
        primary: { label: 'Go live', action: 'start', disabled: false },
        secondary: null,
        // Nothing running: there is nothing to step out of.
        pause: null,
        // No session at all: there is no transcript, so no panel to offer.
        panel: false,
      })
    }
    expect(
      liveControls(session({ status: 'ended' }), null, false, false).primary.action,
    ).toBe('start')
    // An ended session still has a transcript worth opening.
    expect(liveControls(session({ status: 'ended' }), null, false, false).panel).toBe(
      true,
    )
    // …but nothing to pause: the conversation is over.
    expect(liveControls(session({ status: 'ended' }), null, true, false).pause).toBe(null)
  })

  it('offers to end a conversation this browser can already hear', () => {
    expect(liveControls(session(), null, true, false)).toEqual({
      primary: { label: 'End', action: 'stop', disabled: false },
      secondary: null,
      pause: { label: 'Pause', action: 'pause', disabled: false },
      panel: true,
    })
  })

  it('offers to join a conversation this browser cannot hear yet', () => {
    // Started from `mesa live start`, or the page was reloaded mid-session:
    // mesa is talking and nothing here has had a gesture, so the only control
    // used to be the one that destroys the conversation.
    expect(liveControls(session(), null, false, false)).toEqual({
      primary: { label: 'Listen', action: 'listen', disabled: false },
      secondary: { label: 'End', action: 'stop', disabled: false },
      // A browser that never joined is already silent — there is nothing here
      // for a pause to stop, and `Listen` is the press that belongs there.
      pause: null,
      panel: true,
    })
  })

  it('locks while a press is in flight', () => {
    // Starting takes a spawn: the session lands seconds after the click, and
    // until then the button must not still read "Go live" and invite a second.
    expect(liveControls(null, 'start', false, false)).toEqual({
      primary: { label: 'Going live…', action: 'stop', disabled: true },
      secondary: null,
      pause: null,
      panel: false,
    })
    // Not even the join is offered mid-press to a browser that never had a
    // gesture: whichever way this call goes, the answer decides which control
    // belongs here. The panel stays either way — the transcript is still
    // worth reading while the session ends.
    expect(liveControls(session(), 'stop', false, false)).toEqual({
      primary: { label: 'Ending…', action: 'start', disabled: true },
      secondary: null,
      pause: null,
      panel: true,
    })
    expect(liveControls(session(), 'stop', true, false)).toEqual({
      primary: { label: 'Ending…', action: 'start', disabled: true },
      secondary: null,
      // Mid-press, even from a browser that is in the conversation: pausing
      // something that is on its way out is a press with nothing to mean.
      pause: null,
      panel: true,
    })
  })
})

describe('liveControls, pausing', () => {
  it('offers Pause to a browser that is in a running conversation', () => {
    expect(liveControls(session(), null, true, false).pause).toEqual({
      label: 'Pause',
      action: 'pause',
      disabled: false,
    })
  })

  it('flips to Resume once paused, and changes nothing else', () => {
    const held = liveControls(session(), null, true, true)
    expect(held.pause).toEqual({ label: 'Resume', action: 'resume', disabled: false })
    // Pausing is not ending: the conversation is still running, so the primary
    // control still says so.
    expect(held.primary).toEqual({ label: 'End', action: 'stop', disabled: false })
    expect(held.panel).toBe(true)
  })

  it('is offered nowhere else', () => {
    // Not live, joined or not; live but never joined; and mid-press either way.
    expect(liveControls(null, null, true, false).pause).toBe(null)
    expect(liveControls(session({ status: 'ended' }), null, true, true).pause).toBe(null)
    expect(liveControls(session(), null, false, false).pause).toBe(null)
    expect(liveControls(session(), 'stop', true, true).pause).toBe(null)
    expect(liveControls(null, 'start', true, true).pause).toBe(null)
  })
})

describe('liveStatusLine', () => {
  it('reports an error above everything else', () => {
    expect(liveStatusLine(session(), true, 'kokoro-rs is not installed', false)).toBe(
      'kokoro-rs is not installed',
    )
    // Including over a pause: a page that says "paused" while the last call
    // failed is the same lie by a different word.
    expect(liveStatusLine(session(), false, 'kokoro-rs is not installed', true)).toBe(
      'kokoro-rs is not installed',
    )
  })

  it('tells the two not-live states apart', () => {
    expect(liveStatusLine(null, false, null, false)).toMatch(/^Not live\./)
    expect(liveStatusLine(session({ status: 'ended' }), false, null, false)).toMatch(
      /^That conversation has ended\./,
    )
  })

  it('says when it is speaking', () => {
    expect(liveStatusLine(session(), true, null, false)).toBe('Speaking…')
  })

  it('calls out a live session with nothing attached to answer', () => {
    expect(liveStatusLine(session({ agent_id: null }), false, null, false)).toMatch(
      /no agent is attached/,
    )
  })

  it('otherwise says it is listening', () => {
    expect(liveStatusLine(session(), false, null, false)).toMatch(/^Listening\./)
  })

  it('says it is paused, above everything the conversation would say', () => {
    expect(liveStatusLine(session(), false, null, true)).toMatch(/^Paused/)
    // Nothing is sounding once paused, but a straggling `speaking` flag must
    // not make the line claim she is still talking.
    expect(liveStatusLine(session(), true, null, true)).toMatch(/^Paused/)
    // Nor may the no-agent warning lead when the reason nothing is happening
    // is that the person asked for it.
    expect(liveStatusLine(session({ agent_id: null }), false, null, true)).toMatch(
      /^Paused/,
    )
    // A session that ended is not a paused one — that pair of lines describes
    // the session itself, which pause never touched.
    expect(liveStatusLine(session({ status: 'ended' }), false, null, true)).toMatch(
      /^That conversation has ended\./,
    )
    expect(liveStatusLine(null, false, null, true)).toMatch(/^Not live\./)
  })
})
