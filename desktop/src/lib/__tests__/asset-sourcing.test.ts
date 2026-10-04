import { describe, expect, it, vi } from 'vitest'
import {
  buildVisualAssetManifestTemplate,
  buildVisualAssetSourcingInstructions,
  deriveVisualAssetSlots,
  resolveVisualAssets,
  shouldSourceVisualAssets,
} from '../asset-sourcing'

const proxyFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../proxyFetch', () => ({
  proxyFetch: proxyFetchMock,
}))

describe('asset-sourcing', () => {
  it('detects visual-heavy landing page prompts', () => {
    expect(shouldSourceVisualAssets('Build a SaaS landing page with hero image, testimonials, and screenshots')).toBe(true)
    expect(shouldSourceVisualAssets('Create a backend API dashboard')).toBe(false)
  })

  it('derives useful asset slots for marketing pages', () => {
    const slots = deriveVisualAssetSlots('Build a product landing page with hero image, feature section, testimonials, and app screenshots')
    expect(slots.map(slot => slot.id)).toContain('hero-visual')
    expect(slots.map(slot => slot.id)).toContain('feature-visual')
    expect(slots.map(slot => slot.id)).toContain('social-proof-visual')
    expect(slots.map(slot => slot.id)).toContain('product-shot')
  })

  it('builds sourcing instructions that tell the agent to write assets.md', () => {
    const text = buildVisualAssetSourcingInstructions('Build a landing page with images')
    expect(text).toContain('.betopia/assets.md')
    expect(text).toContain('licensed')
    expect(text).toContain('Asset slots to fill')
  })

  it('builds an assets manifest template with slot details', () => {
    const text = buildVisualAssetManifestTemplate('Build a portfolio showcase with a hero banner')
    expect(text).toContain('# Asset Plan')
    expect(text).toContain('Hero visual')
    expect(text).toContain('Selection Summary')
  })

  it('resolves direct web image assets without MCP', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Modern Bakery Storefront',
            url: 'https://images.example.com/bakery.jpg',
            foreign_landing_url: 'https://example.com/source',
            creator: 'Example Creator',
            creator_url: 'https://example.com/creator',
            license: 'by',
            license_version: '4.0',
            license_url: 'https://creativecommons.org/licenses/by/4.0/',
            attribution: 'Attribution text',
            tags: [{ name: 'bakery' }, { name: 'storefront' }],
            width: 1600,
            height: 900,
          },
        ],
      }),
    } as any)

    const bundle = await resolveVisualAssets('Build a bakery landing page with a hero image')

    expect(bundle.selections).toHaveLength(1)
    expect(bundle.selections[0].imageUrl).toBe('https://images.example.com/bakery.jpg')
    expect(bundle.selections[0].sourceUrl).toBe('https://example.com/source')
    expect(bundle.selections[0].altText).toContain('Hero image')
  })
})
