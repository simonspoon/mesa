import { describe, expect, it, vi } from 'vitest'
import * as ptyPool from './ptyPool'

// The pool is module state shared by every test in this file, so each case
// works on an id of its own and cleans it up — `remove` is itself under test.
function leaf(name: string): string {
  const id = `${name}-${Math.random().toString(36).slice(2)}`
  ptyPool.ensure(id, { endpoint: '/api/terminal/attach', closedMessage: 'closed' })
  return id
}

describe('ptyPool', () => {
  it('send is false with no registered writer', () => {
    const id = leaf('send')
    expect(ptyPool.send(id, 'hello')).toBe(false)
    ptyPool.remove(id)
  })

  it('reconnect is false for an unknown id', () => {
    expect(ptyPool.reconnect('no-such-leaf')).toBe(false)
  })

  it('reconnect calls the registered reconnector', () => {
    const id = leaf('reconnect')
    const fn = vi.fn()
    ptyPool.setReconnector(id, fn)
    expect(ptyPool.reconnect(id)).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    ptyPool.remove(id)
  })

  it('setReconnector(id, null) clears it', () => {
    const id = leaf('clear')
    ptyPool.setReconnector(id, vi.fn())
    ptyPool.setReconnector(id, null)
    expect(ptyPool.reconnect(id)).toBe(false)
    ptyPool.remove(id)
  })

  it('remove drops both the sender and the reconnector', () => {
    const id = leaf('remove')
    ptyPool.setSender(id, () => true)
    ptyPool.setReconnector(id, vi.fn())
    ptyPool.remove(id)
    expect(ptyPool.send(id, 'hello')).toBe(false)
    expect(ptyPool.reconnect(id)).toBe(false)
  })
})
