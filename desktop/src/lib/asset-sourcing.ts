import { proxyFetch } from './proxyFetch'

export interface VisualAssetSlot {
  id: string
  label: string
  purpose: string
  hints: string[]
  required: boolean
}

export interface VisualAssetSelection {
  slotId: string
  slotLabel: string
  query: string
  title: string
  imageUrl: string
  sourceUrl: string
  creator: string
  creatorUrl: string
  license: string
  licenseUrl: string
  attribution: string
  altText: string
  note: string
}

export interface VisualAssetBundle {
  topic: string
  slots: VisualAssetSlot[]
  selections: VisualAssetSelection[]
  missingSlots: VisualAssetSlot[]
}

type OpenverseImage = {
  title?: string
  url?: string
  thumbnail?: string
  source?: string
  foreign_landing_url?: string
  creator?: string
  creator_url?: string
  license?: string
  license_version?: string
  license_url?: string
  attribution?: string
  tags?: Array<{ name?: string }>
  mature?: boolean
  width?: number
  height?: number
}

const OPENVERSE_IMAGES_URL = 'https://api.openverse.org/v1/images/'
const OPENVERSE_PAGE_SIZE = 8

const VISUAL_INTENT_RE = /\b(website|web app|landing page|homepage|home page|marketing site|marketing page|startup site|saas|product page|product landing|portfolio|showcase|hero image|hero section|banner|cover image|gallery|photo|illustration|visuals|images?|screenshots?|mockup|cards? with images?|ecommerce|restaurant|travel|fashion|real estate|agency|event|case study|testimonial logos?|brand imagery)\b/i
const VISUAL_PAGE_RE = /\b(website|web page|page|screen|section|layout|interface|ui|ui\/ux|landing|hero|banner)\b/i
const UTILITARIAN_RE = /\b(dashboard|admin|api|backend|cli|terminal|database|settings|auth|login|docs?|documentation|developer tool|internal tool|utility|monitoring|analytics)\b/i

const ASSET_CACHE = new Map<string, Promise<VisualAssetBundle>>()

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'apps', 'about', 'as', 'at', 'build', 'building',
  'create', 'design', 'for', 'from', 'get', 'give', 'in', 'into', 'it', 'keep',
  'landing', 'make', 'new', 'page', 'pages', 'product', 'site', 'sites', 'the',
  'this', 'that', 'to', 'ui', 'ux', 'web', 'website', 'webapp', 'with', 'your',
  'our', 'my', 'their', 'best', 'modern', 'clean', 'responsive', 'beautiful',
  'simple', 'complete', 'feature', 'features', 'project', 'show', 'use', 'using',
  'hero', 'image', 'images', 'photo', 'photos', 'illustration', 'illustrations',
  'screenshot', 'screenshots', 'mockup', 'mockups', 'banner', 'cover', 'gallery',
  'logo', 'logos', 'visual', 'visuals', 'background',
  'on', 'of', 'or', 'please', 'need', 'needs', 'help', 'me', 'we', 'you',
])

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ')
}

function tokenize(prompt: string): string[] {
  return normalizePrompt(prompt)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => word && !STOP_WORDS.has(word))
}

function extractSearchTopic(prompt: string): string {
  const tokens = tokenize(prompt)
  if (tokens.length > 0) {
    return tokens.slice(0, 6).join(' ')
  }
  return normalizePrompt(prompt).slice(0, 60) || 'visual reference'
}

function splitHints(prompt: string): string[] {
  const text = prompt.toLowerCase()
  const hints = new Set<string>()
  if (/\b(hero|banner|cover|masthead)\b/.test(text)) hints.add('hero')
  if (/\b(feature|benefit|services?|capabilities?|solution)\b/.test(text)) hints.add('feature')
  if (/\b(testimonial|review|social proof|client logo|logo wall|trust)\b/.test(text)) hints.add('social-proof')
  if (/\b(gallery|portfolio|showcase|case study|examples?)\b/.test(text)) hints.add('gallery')
  if (/\b(product|app|screenshot|mockup|dashboard|device|screen)\b/.test(text)) hints.add('product-shot')
  if (/\b(background|texture|pattern|gradient|ambient)\b/.test(text)) hints.add('background')
  if (/\b(team|about|founder|people|profile)\b/.test(text)) hints.add('people')
  if (/\b(logo|brand mark|brand)\b/.test(text)) hints.add('logo')
  return [...hints]
}

function slotQueryFragment(slot: VisualAssetSlot): string {
  if (slot.id === 'hero-visual') return 'hero image'
  if (slot.id === 'feature-visual') return 'illustration'
  if (slot.id === 'social-proof-visual') return 'logo wall'
  if (slot.id === 'gallery-visual') return 'showcase image'
  if (slot.id === 'product-shot') return 'screenshot mockup'
  if (slot.id === 'background-asset') return 'abstract background'
  if (slot.id === 'people-visual') return 'team photo'
  if (slot.id === 'logo-asset') return 'brand logo'
  return slot.label.toLowerCase()
}

function buildQueryCandidates(topic: string, slot: VisualAssetSlot): string[] {
  const queries = [
    `${topic} ${slotQueryFragment(slot)}`.trim(),
    `${topic} ${slot.label}`.trim(),
    topic,
    slotQueryFragment(slot),
  ]
  return [...new Set(queries.filter(Boolean))]
}

function scoreImage(result: OpenverseImage, topicTokens: string[], slot: VisualAssetSlot): number {
  const haystack = [
    result.title,
    result.creator,
    result.license,
    result.attribution,
    ...(result.tags?.map(tag => tag.name ?? '') ?? []),
  ]
    .join(' ')
    .toLowerCase()

  let score = 0
  for (const token of topicTokens) {
    if (token.length < 3) continue
    if (haystack.includes(token)) score += 4
  }

  for (const hint of slot.hints) {
    const cleaned = hint.replace(/-/g, ' ')
    if (haystack.includes(cleaned)) score += 3
  }

  if (result.title) score += 1
  if (result.creator) score += 1
  if (result.foreign_landing_url) score += 1
  if (result.width && result.height) {
    const ratio = result.width / Math.max(1, result.height)
    if (slot.id === 'hero-visual' && ratio >= 1.15) score += 2
    if (slot.id === 'product-shot' && ratio < 1.4) score += 1
    if (slot.id === 'background-asset' && ratio > 1.2) score += 1
  }
  if (result.mature) score -= 100
  return score
}

function normalizeLicense(result: OpenverseImage): string {
  const license = result.license?.trim() || 'unknown'
  const version = result.license_version?.trim()
  return version ? `${license} ${version}` : license
}

function buildAltText(topic: string, slot: VisualAssetSlot, result: OpenverseImage): string {
  const subject = result.title?.trim() || topic
  if (slot.id === 'hero-visual') return `Hero image for ${subject}`
  if (slot.id === 'feature-visual') return `Illustration for ${subject}`
  if (slot.id === 'social-proof-visual') return `Social proof image for ${subject}`
  if (slot.id === 'gallery-visual') return `Gallery image for ${subject}`
  if (slot.id === 'product-shot') return `Product screenshot for ${subject}`
  if (slot.id === 'background-asset') return `Background image for ${subject}`
  return `${slot.label} for ${subject}`
}

async function searchOpenverseImages(query: string): Promise<OpenverseImage[]> {
  const url = `${OPENVERSE_IMAGES_URL}?q=${encodeURIComponent(query)}&page_size=${OPENVERSE_PAGE_SIZE}`
  const response = await proxyFetch(url)
  if (!response.ok) return []
  const data = await response.json() as { results?: OpenverseImage[] }
  return Array.isArray(data.results) ? data.results : []
}

function pickBestCandidate(
  results: OpenverseImage[],
  topicTokens: string[],
  slot: VisualAssetSlot,
  usedUrls: Set<string>,
): OpenverseImage | null {
  const ranked = results
    .filter(result => Boolean(result.url))
    .sort((a, b) => scoreImage(b, topicTokens, slot) - scoreImage(a, topicTokens, slot))
  for (const candidate of ranked) {
    if (!candidate.url) continue
    if (usedUrls.has(candidate.url)) continue
    return candidate
  }
  return null
}

export function shouldSourceVisualAssets(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  if (UTILITARIAN_RE.test(normalized)) return false
  if (!VISUAL_INTENT_RE.test(normalized)) return false
  return VISUAL_PAGE_RE.test(normalized) || /\b(image|images|photo|photos|illustration|screenshot|mockup|gallery|banner|cover|logo)\b/i.test(normalized)
}

export function deriveVisualAssetSlots(prompt: string): VisualAssetSlot[] {
  if (!shouldSourceVisualAssets(prompt)) return []

  const text = prompt.toLowerCase()
  const slots: VisualAssetSlot[] = []
  const baseHints = splitHints(prompt)

  slots.push({
    id: 'hero-visual',
    label: 'Hero visual',
    purpose: 'Primary visual for the top of the page or first screenful.',
    hints: [...baseHints, 'hero', 'primary-visual'],
    required: true,
  })

  if (/\b(feature|benefit|service|capability|solution|section)\b/.test(text)) {
    slots.push({
      id: 'feature-visual',
      label: 'Feature or benefit visual',
      purpose: 'Illustration, screenshot, or contextual image for a feature section.',
      hints: [...baseHints, 'feature', 'section-visual'],
      required: false,
    })
  }

  if (/\b(testimonials?|reviews?|social proof|logos?|clients?|partners?|trust)\b/.test(text)) {
    slots.push({
      id: 'social-proof-visual',
      label: 'Trust or social-proof asset',
      purpose: 'Client logo strip, testimonial headshots, or trust badge imagery.',
      hints: [...baseHints, 'social-proof'],
      required: false,
    })
  }

  if (/\b(gallery|portfolio|showcase|case study|examples?)\b/.test(text)) {
    slots.push({
      id: 'gallery-visual',
      label: 'Gallery or showcase asset',
      purpose: 'Supporting image for a gallery, portfolio, or case study block.',
      hints: [...baseHints, 'gallery'],
      required: false,
    })
  }

  if (/\b(product|app|mockup|screenshot|device|screen)\b/.test(text)) {
    slots.push({
      id: 'product-shot',
      label: 'Product screenshot or mockup',
      purpose: 'Device mockup, app screenshot, or product shot for the main value prop.',
      hints: [...baseHints, 'product-shot'],
      required: false,
    })
  }

  if (/\b(background|texture|pattern|ambient|gradient)\b/.test(text)) {
    slots.push({
      id: 'background-asset',
      label: 'Background asset',
      purpose: 'Subtle texture, pattern, or atmospheric image to avoid empty visual space.',
      hints: [...baseHints, 'background'],
      required: false,
    })
  }

  if (/\b(team|people|founder|about|profile)\b/.test(text)) {
    slots.push({
      id: 'people-visual',
      label: 'People visual',
      purpose: 'Team photo or portrait-style image for about/team sections.',
      hints: [...baseHints, 'people'],
      required: false,
    })
  }

  if (/\b(logo|brand)\b/.test(text)) {
    slots.push({
      id: 'logo-asset',
      label: 'Brand asset',
      purpose: 'Logo or brand mark when the page needs a visible brand graphic.',
      hints: [...baseHints, 'logo'],
      required: false,
    })
  }

  return slots
}

export async function resolveVisualAssets(prompt: string): Promise<VisualAssetBundle> {
  const normalized = normalizePrompt(prompt)
  const cached = ASSET_CACHE.get(normalized)
  if (cached) return cached

  const request = (async (): Promise<VisualAssetBundle> => {
    const slots = deriveVisualAssetSlots(prompt)
    const topic = extractSearchTopic(prompt)
    const topicTokens = tokenize(topic)
    const selections: VisualAssetSelection[] = []
    const usedUrls = new Set<string>()

    for (const slot of slots) {
      const queries = buildQueryCandidates(topic, slot)
      let chosen: OpenverseImage | null = null

      for (const query of queries) {
        const results = await searchOpenverseImages(query)
        chosen = pickBestCandidate(results, topicTokens, slot, usedUrls)
        if (chosen?.url) break
      }

      if (!chosen?.url) continue

      usedUrls.add(chosen.url)
      const imageUrl = chosen.url
      const sourceUrl = chosen.foreign_landing_url?.trim() || chosen.url
      selections.push({
        slotId: slot.id,
        slotLabel: slot.label,
        query: queries[0] ?? topic,
        title: chosen.title?.trim() || slot.label,
        imageUrl,
        sourceUrl,
        creator: chosen.creator?.trim() || 'unknown',
        creatorUrl: chosen.creator_url?.trim() || '',
        license: normalizeLicense(chosen),
        licenseUrl: chosen.license_url?.trim() || '',
        attribution: chosen.attribution?.trim() || '',
        altText: buildAltText(topic, slot, chosen),
        note: `Openverse result from ${chosen.source ?? 'web'}${chosen.thumbnail ? ' with thumbnail preview' : ''}`,
      })
    }

    const missingSlots = slots.filter(slot => !selections.some(selection => selection.slotId === slot.id))
    return { topic, slots, selections, missingSlots }
  })()

  ASSET_CACHE.set(normalized, request)
  return request
}

function renderSlotLines(slots: VisualAssetSlot[]): string {
  return slots.map(slot => {
    const hints = slot.hints.length > 0 ? ` hints: ${slot.hints.join(', ')}` : ''
    return `- ${slot.label} (${slot.required ? 'required' : 'optional'}): ${slot.purpose}${hints}`
  }).join('\n')
}

function renderSelectionLines(bundle: VisualAssetBundle): string {
  return bundle.selections.map(selection => [
    `### ${selection.slotLabel}`,
    '',
    `- Query: ${selection.query}`,
    `- Title: ${selection.title}`,
    `- Image URL: ${selection.imageUrl}`,
    `- Source URL: ${selection.sourceUrl}`,
    `- Creator: ${selection.creator}`,
    `- Creator URL: ${selection.creatorUrl || 'n/a'}`,
    `- License: ${selection.license}`,
    `- License URL: ${selection.licenseUrl || 'n/a'}`,
    `- Alt text: ${selection.altText}`,
    `- Notes: ${selection.note}`,
  ].join('\n')).join('\n\n')
}

function renderSelectionSummary(bundle?: VisualAssetBundle | null): string {
  if (!bundle) {
    return [
      '- [ ] Each required slot has a chosen asset or a documented fallback.',
      '- [ ] Selected assets are relevant to the requested topic and layout.',
      '- [ ] `.betopia/assets.md` has source URLs and alt text for later reuse.',
    ].join('\n')
  }
  const missing = bundle.missingSlots.length > 0
    ? `- Missing slots: ${bundle.missingSlots.map(slot => slot.label).join(', ')}`
    : '- Missing slots: none'
  return [
    bundle.selections.length > 0
      ? `- [x] Selected ${bundle.selections.length} image${bundle.selections.length === 1 ? '' : 's'} from web sources.`
      : '- [ ] No image selected yet.',
    missing,
    '- [ ] Selected assets are relevant to the requested topic and layout.',
    '- [ ] `.betopia/assets.md` has source URLs and alt text for later reuse.',
  ].join('\n')
}

export function buildVisualAssetSourcingInstructions(prompt: string, bundle?: VisualAssetBundle | null): string {
  const slots = bundle?.slots ?? deriveVisualAssetSlots(prompt)
  if (slots.length === 0) return ''
  const selectedBundle = bundle && bundle.selections.length > 0 ? bundle : null

  const selectedLines = selectedBundle
    ? [
        '',
        '### Sourced candidates',
        renderSelectionLines(selectedBundle),
      ].join('\n')
    : ''

  return [
    '## Visual Asset Sourcing',
    'The requested page appears to need visual assets. Do not leave hero, gallery, product, or testimonial areas empty.',
    'The app can source candidate images directly from the web and may already have provided some URLs below. Reuse those first.',
    'If the user already provided images, reuse those first. Otherwise use the selected image URLs, alt text, and source notes from `.betopia/assets.md`.',
    'Avoid unsafe, low-quality, irrelevant, or poorly licensed images. If no safe image can be found for a slot, use a neutral placeholder only after noting the gap.',
    '',
    '### Asset slots to fill',
    renderSlotLines(slots),
    selectedLines,
    '',
    '### Required output file',
    'Write `.betopia/assets.md` with:',
    '- original request summary',
    '- asset slots and the chosen image URLs',
    '- why each asset was selected',
    '- alt text',
    '- source / provenance',
    '- any license or attribution notes that were visible',
    '- fallback decision if a slot could not be filled',
    '',
    '### Working rule',
    'Keep the selected asset list out of chat history; store it in `.betopia/assets.md` so later build steps can reuse it.',
  ].join('\n')
}

export function buildVisualAssetManifestTemplate(prompt: string, bundle?: VisualAssetBundle | null): string {
  const slots = bundle?.slots ?? deriveVisualAssetSlots(prompt)
  if (slots.length === 0) return ''
  const selectedBundle = bundle && bundle.selections.length > 0 ? bundle : null

  const entries = selectedBundle
    ? renderSelectionLines(selectedBundle)
    : slots.map(slot => [
        `### ${slot.label}`,
        '',
        `- Slot ID: ${slot.id}`,
        `- Required: ${slot.required ? 'yes' : 'no'}`,
        `- Purpose: ${slot.purpose}`,
        `- Hints: ${slot.hints.join(', ') || 'none'}`,
        '- Selected asset: ',
        '- Image URL: ',
        '- Source URL: ',
        '- Creator: ',
        '- License: ',
        '- Alt text: ',
        '- Notes: ',
      ].join('\n')).join('\n\n')

  return [
    '# Asset Plan',
    '',
    '## Original Request',
    prompt.trim(),
    '',
    '## Asset Slots',
    entries,
    '',
    '## Research Notes',
    '- Search image sources before leaving any major visual area empty.',
    '- Reuse user-provided images first when available.',
    '- Prefer licensed or attributable assets.',
    '',
    '## Selection Summary',
    renderSelectionSummary(bundle),
  ].join('\n')
}
