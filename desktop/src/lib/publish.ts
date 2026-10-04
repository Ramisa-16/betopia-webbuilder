export type PublishVisibility = 'anyone' | 'invited'

export interface PublishState {
  visibility: PublishVisibility
  isPublished: boolean
  hideBuilderBadge: boolean
  publishedUrl?: string
  updatedAt?: number
}

const DEFAULT_STATE: PublishState = {
  visibility: 'anyone',
  isPublished: false,
  hideBuilderBadge: false,
}

function toKey(projectPath: string): string {
  return 'betopia_publish_state:' + encodeURIComponent(projectPath)
}

export function getDefaultPublishState(): PublishState {
  return { ...DEFAULT_STATE }
}

export function loadPublishState(projectPath: string): PublishState {
  if (!projectPath) return getDefaultPublishState()
  try {
    const raw = localStorage.getItem(toKey(projectPath))
    if (!raw) return getDefaultPublishState()
    const parsed = JSON.parse(raw) as Partial<PublishState>
    return {
      ...DEFAULT_STATE,
      ...parsed,
    }
  } catch {
    return getDefaultPublishState()
  }
}

export function savePublishState(projectPath: string, state: PublishState): void {
  if (!projectPath) return
  const payload: PublishState = {
    ...state,
    updatedAt: Date.now(),
  }
  localStorage.setItem(toKey(projectPath), JSON.stringify(payload))
}
