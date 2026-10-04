import type { PluginPermissionManifest } from './plugin-api'

export interface PermissionCheck {
  allowed: boolean
  reason?: string
}

export function checkNetworkPermission(manifest: PluginPermissionManifest | undefined, url: string): PermissionCheck {
  if (!manifest?.network?.origins?.length) {
    return { allowed: false, reason: 'plugin did not declare network permission' }
  }
  const allowed = manifest.network.origins.some(pattern => matchOrigin(url, pattern))
  if (!allowed) {
    return { allowed: false, reason: `URL "${url}" not in permitted origins` }
  }
  return { allowed: true }
}

export function checkFilesystemPermission(
  manifest: PluginPermissionManifest | undefined,
  path: string,
  operation: 'read' | 'write',
): PermissionCheck {
  const rules = operation === 'read' ? manifest?.filesystem?.read : manifest?.filesystem?.write
  if (!rules?.length) {
    return { allowed: false, reason: `plugin did not declare filesystem ${operation} permission` }
  }
  const allowed = rules.some(pattern => matchGlob(path, pattern))
  if (!allowed) {
    return { allowed: false, reason: `Path "${path}" not in permitted ${operation} paths` }
  }
  return { allowed: true }
}

export function checkShellPermission(manifest: PluginPermissionManifest | undefined): PermissionCheck {
  if (!manifest?.shell) {
    return { allowed: false, reason: 'plugin did not declare shell permission' }
  }
  return { allowed: true }
}

function matchOrigin(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url)
    const patternParts = pattern.split('://')
    if (patternParts.length !== 2) return false
    const [schemePart, hostPart] = patternParts
    if (schemePart !== '*' && schemePart !== parsed.protocol.replace(':', '')) return false
    // Match hostname + pathname against the hostPart (which may include a path glob)
    const urlPath = parsed.hostname + parsed.pathname
    return matchGlob(urlPath, hostPart)
  } catch {
    return false
  }
}

function matchGlob(value: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$'
  )
  return regex.test(value)
}
