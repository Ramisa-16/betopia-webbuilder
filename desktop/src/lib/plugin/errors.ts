export class PluginError extends Error {
  constructor(
    message: string,
    public readonly pluginId: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export class PluginLoadError extends PluginError {
  constructor(pluginId: string, message: string, public readonly cause?: unknown) {
    super(`Plugin "${pluginId}" load error: ${message}`, pluginId, 'LOAD_ERROR')
    this.name = 'PluginLoadError'
  }
}

export class PluginPermissionDenied extends PluginError {
  constructor(pluginId: string, public readonly permission: string, public readonly resource: string) {
    super(`Plugin "${pluginId}" denied: missing "${permission}" permission for "${resource}"`, pluginId, 'PERMISSION_DENIED')
    this.name = 'PluginPermissionDenied'
  }
}

export class PluginTimeoutError extends PluginError {
  constructor(pluginId: string, public readonly hookName: string, public readonly durationMs: number) {
    super(`Plugin "${pluginId}" hook "${hookName}" timed out after ${durationMs}ms`, pluginId, 'TIMEOUT')
    this.name = 'PluginTimeoutError'
  }
}
