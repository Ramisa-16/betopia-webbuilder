export function normalizeDialogPath(value: unknown): string | null {
    if (value == null) {
        return null
    }

    const raw = Array.isArray(value) ? value[0] : value
    const path = String(raw).trim()
    if (!path) {
        return null
    }

    return stripFileUri(path)
}

export function stripFileUri(path: string): string {
    if (!path.startsWith('file://')) {
        return path
    }

    try {
        const decoded = decodeURI(path)
        return decoded.replace(/^file:(?:\/\/)+(?:localhost)?/, '')
    } catch {
        return path.replace(/^file:(?:\/\/)+(?:localhost)?/, '')
    }
}
