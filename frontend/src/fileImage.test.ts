import { describe, expect, it } from 'vitest'
import { imageMimeForPath, isImagePath } from './fileImage'

describe('imageMimeForPath', () => {
  it('maps every allowlisted extension to its MIME type', () => {
    expect(imageMimeForPath('a.png')).toBe('image/png')
    expect(imageMimeForPath('a.jpg')).toBe('image/jpeg')
    expect(imageMimeForPath('a.jpeg')).toBe('image/jpeg')
    expect(imageMimeForPath('a.gif')).toBe('image/gif')
    expect(imageMimeForPath('a.webp')).toBe('image/webp')
    expect(imageMimeForPath('a.bmp')).toBe('image/bmp')
    expect(imageMimeForPath('a.ico')).toBe('image/x-icon')
    expect(imageMimeForPath('a.svg')).toBe('image/svg+xml')
  })

  it('is case-insensitive on the extension', () => {
    expect(imageMimeForPath('A.PNG')).toBe('image/png')
    expect(imageMimeForPath('logo.JpEg')).toBe('image/jpeg')
    expect(imageMimeForPath('docs/Icon.ICO')).toBe('image/x-icon')
  })

  it('reads the FINAL extension only', () => {
    expect(imageMimeForPath('foo.png.html')).toBeNull()
    expect(imageMimeForPath('foo.html.png')).toBe('image/png')
  })

  it('rejects text file types', () => {
    expect(imageMimeForPath('a.html')).toBeNull()
    expect(imageMimeForPath('a.htm')).toBeNull()
    expect(imageMimeForPath('a.md')).toBeNull()
    expect(imageMimeForPath('a.rs')).toBeNull()
    expect(imageMimeForPath('a.json')).toBeNull()
  })

  it('rejects a path with no extension', () => {
    expect(imageMimeForPath('README')).toBeNull()
    expect(imageMimeForPath('src/core/store')).toBeNull()
    expect(imageMimeForPath('')).toBeNull()
  })

  it('rejects a dotfile, whose leading dot is not an extension marker', () => {
    expect(imageMimeForPath('.gitignore')).toBeNull()
    expect(imageMimeForPath('cfg/.env')).toBeNull()
    expect(imageMimeForPath('.png')).toBeNull()
  })

  it('ignores dots in parent directories', () => {
    expect(imageMimeForPath('a.png/README')).toBeNull()
    expect(imageMimeForPath('v1.2/logo.png')).toBe('image/png')
  })
})

describe('isImagePath', () => {
  it('is the boolean face of imageMimeForPath', () => {
    expect(isImagePath('docs/logo.svg')).toBe(true)
    expect(isImagePath('docs/notes.md')).toBe(false)
    expect(isImagePath('.gitignore')).toBe(false)
  })
})
