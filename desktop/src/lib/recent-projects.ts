const RECENT_PROJECTS_KEY = 'betopia_recent_projects_v2'
const LEGACY_RECENT_PROJECTS_KEY = 'betopia_recent_paths'

export function getRecentProjectPaths(): string[] {
  const paths = new Set<string>()
  try {
    const recents = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]') as Array<{ path?: string }>
    for (const recent of recents) {
      if (recent?.path) paths.add(recent.path)
    }
  } catch {}
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_RECENT_PROJECTS_KEY) ?? '[]') as string[]
    for (const path of legacy) {
      if (path) paths.add(path)
    }
  } catch {}
  return [...paths]
}
