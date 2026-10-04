import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

export interface OllamaGenerateArgs {
  model: string
  prompt: string
  stream?: boolean
  // Additional optional fields can be added here as Ollama supports them
}

/**
 * Call the local Ollama `/api/generate` endpoint.
 * Example curl equivalent:
 * curl http://localhost:11434/api/generate -d '{"model":"starcoder:latest","prompt":"Write a Python API server","stream":false}'
 */
export async function generateOllama(args: OllamaGenerateArgs): Promise<any> {
  const url = 'http://localhost:11434/api/generate'
  const init: Parameters<typeof tauriFetch>[1] = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.model, prompt: args.prompt, stream: Boolean(args.stream) }),
  }

  const r = await tauriFetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(text || `Ollama request failed: ${r.status}`)
  }

  // When stream=false Ollama typically returns JSON; try parse as JSON, fallback to text
  try {
    return await r.json()
  } catch {
    return await r.text()
  }
}

export default generateOllama
