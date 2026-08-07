import { describe, expect, it } from 'vitest'
import { imageFilesFromClipboard } from './clipboardFiles'

const NOW = 1700000000000

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

/** A `DataTransferItem`-shaped entry, as a browser paste supplies one. */
function item(f: File | null) {
  return {
    kind: f ? 'file' : 'string',
    type: f ? f.type : 'text/plain',
    getAsFile: () => f,
  }
}

describe('imageFilesFromClipboard', () => {
  it('returns nothing for a null clipboard or an empty one', () => {
    expect(imageFilesFromClipboard(null, NOW)).toEqual([])
    expect(imageFilesFromClipboard({}, NOW)).toEqual([])
    expect(imageFilesFromClipboard({ items: [], files: [] }, NOW)).toEqual([])
  })

  it('returns nothing for a plain-text paste, so the caller does not preventDefault', () => {
    expect(imageFilesFromClipboard({ items: [item(null)] }, NOW)).toEqual([])
  })

  it('synthesises a dated name with a server-recognised extension', () => {
    const [f] = imageFilesFromClipboard(
      { items: [item(file('', 'image/png'))] },
      NOW,
    )
    expect(f.name).toBe(`pasted-${NOW}.png`)
    expect(f.type).toBe('image/png')
  })

  it('renames a clipboard image whose name carries no extension', () => {
    const [f] = imageFilesFromClipboard(
      { items: [item(file('screenshot', 'image/png'))] },
      NOW,
    )
    expect(f.name).toBe(`pasted-${NOW}.png`)
  })

  it('maps each MIME type the Rust guesser knows', () => {
    const cases: [string, string][] = [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/gif', 'gif'],
      ['image/webp', 'webp'],
      ['image/svg+xml', 'svg'],
    ]
    for (const [type, ext] of cases) {
      const [f] = imageFilesFromClipboard(
        { items: [item(file('', type))] },
        NOW,
      )
      expect(f.name).toBe(`pasted-${NOW}.${ext}`)
    }
  })

  it('falls back to the subtype for an unknown image type, stripped of a +suffix', () => {
    const [heic] = imageFilesFromClipboard(
      { items: [item(file('', 'image/heic'))] },
      NOW,
    )
    expect(heic.name).toBe(`pasted-${NOW}.heic`)
    const [odd] = imageFilesFromClipboard(
      { items: [item(file('', 'image/vnd.foo+xml'))] },
      NOW,
    )
    expect(odd.name).toBe(`pasted-${NOW}.vnd.foo`)
  })

  it('keeps a supplied name that already carries a recognised extension', () => {
    const [f] = imageFilesFromClipboard(
      { items: [item(file('Screenshot 2026.PNG', 'image/png'))] },
      NOW,
    )
    expect(f.name).toBe('Screenshot 2026.PNG')
  })

  it('renames a supplied name whose extension the server cannot type', () => {
    const [f] = imageFilesFromClipboard(
      { items: [item(file('clip.bmp', 'image/png'))] },
      NOW,
    )
    expect(f.name).toBe(`pasted-${NOW}.png`)
  })

  it('takes only the image from a screenshot paste that also carries text', () => {
    const files = imageFilesFromClipboard(
      { items: [item(null), item(file('', 'image/png'))] },
      NOW,
    )
    expect(files.map((f) => f.name)).toEqual([`pasted-${NOW}.png`])
  })

  it('gives every image in a multi-image paste a distinct name', () => {
    const files = imageFilesFromClipboard(
      {
        items: [
          item(file('', 'image/png')),
          item(file('', 'image/png')),
          item(file('', 'image/jpeg')),
        ],
      },
      NOW,
    )
    expect(files.map((f) => f.name)).toEqual([
      `pasted-${NOW}.png`,
      `pasted-${NOW}-1.png`,
      `pasted-${NOW}-2.jpg`,
    ])
  })

  it('reads `files` when the clipboard exposes no items', () => {
    const files = imageFilesFromClipboard(
      { files: [file('', 'image/png'), file('note.txt', 'text/plain')] },
      NOW,
    )
    expect(files.map((f) => f.name)).toEqual([`pasted-${NOW}.png`])
  })
})
