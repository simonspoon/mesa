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
    started_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ended_at: null,
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
      expect(liveControls(null, null, unlocked)).toEqual({
        primary: { label: 'Go live', action: 'start', disabled: false },
        secondary: null,
      })
    }
    expect(liveControls(session({ status: 'ended' }), null, false).primary.action).toBe(
      'start',
    )
  })

  it('offers to end a conversation this browser can already hear', () => {
    expect(liveControls(session(), null, true)).toEqual({
      primary: { label: 'End', action: 'stop', disabled: false },
      secondary: null,
    })
  })

  it('offers to join a conversation this browser cannot hear yet', () => {
    // Started from `mesa live start`, or the page was reloaded mid-session:
    // mesa is talking and nothing here has had a gesture, so the only control
    // used to be the one that destroys the conversation.
    expect(liveControls(session(), null, false)).toEqual({
      primary: { label: 'Listen', action: 'listen', disabled: false },
      secondary: { label: 'End', action: 'stop', disabled: false },
    })
  })

  it('locks while a press is in flight', () => {
    // Starting takes a spawn: the session lands seconds after the click, and
    // until then the button must not still read "Go live" and invite a second.
    expect(liveControls(null, 'start', false)).toEqual({
      primary: { label: 'Going live…', action: 'stop', disabled: true },
      secondary: null,
    })
    // Not even the join is offered mid-press: whichever way this call goes,
    // the answer decides which control belongs here.
    expect(liveControls(session(), 'stop', false)).toEqual({
      primary: { label: 'Ending…', action: 'start', disabled: true },
      secondary: null,
    })
  })
})

describe('liveStatusLine', () => {
  it('reports an error above everything else', () => {
    expect(liveStatusLine(session(), true, 'kokoro-rs is not installed')).toBe(
      'kokoro-rs is not installed',
    )
  })

  it('tells the two not-live states apart', () => {
    expect(liveStatusLine(null, false, null)).toMatch(/^Not live\./)
    expect(liveStatusLine(session({ status: 'ended' }), false, null)).toMatch(
      /^That conversation has ended\./,
    )
  })

  it('says when it is speaking', () => {
    expect(liveStatusLine(session(), true, null)).toBe('Speaking…')
  })

  it('calls out a live session with nothing attached to answer', () => {
    expect(liveStatusLine(session({ agent_id: null }), false, null)).toMatch(
      /no agent is attached/,
    )
  })

  it('otherwise says it is listening', () => {
    expect(liveStatusLine(session(), false, null)).toMatch(/^Listening\./)
  })
})
