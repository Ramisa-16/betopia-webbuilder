/**
 * MCP Stdio-to-HTTP Wrapper
 * Wraps stdio MCP servers (like figma-developer-mcp) with an HTTP server
 * so they can be used with the agent's HTTP-based MCP integration.
 *
 * Usage:
 *   const wrapper = new StdioMCPWrapper('figma', 'npx', ['-y', 'figma-developer-mcp', '--stdio'])
 *   const port = await wrapper.start()
 *   // Now use http://localhost:{port} in Agent Settings as an HTTP MCP server
 */

import { Command } from '@tauri-apps/plugin-shell'
// @ts-ignore - Node.js compatibility
import { createServer } from 'node:http'

interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string }
}

export class StdioMCPWrapper {
  private name: string
  private command: string
  private args: string[]
  private env: Record<string, string>
  private child: any = null
  private server: any = null
  public port: number = 0
  private buffer = ''
  private responseHandlers = new Map<string | number, (data: JSONRPCResponse) => void>()
  private nextId = 1

  constructor(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string> = {},
  ) {
    this.name = name
    this.command = command
    this.args = args
    this.env = env
  }

  async start(port: number = 0): Promise<number> {
    // Spawn the stdio MCP process
    try {
      const cmd = await Command.create(this.command, this.args, {
        env: { ...(globalThis as any).process?.env, ...this.env },
      })
      this.child = await cmd.spawn()
      console.log(`Spawned stdio MCP server: ${this.name}`)
    } catch (err) {
      throw new Error(`Failed to spawn ${this.name}: ${err}`)
    }

    // Create HTTP wrapper server
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }

        let body = ''
        req.on('data', (chunk: any) => {
          body += chunk.toString()
        })

        req.on('end', async () => {
          try {
            const jsonrpcReq = JSON.parse(body) as JSONRPCRequest
            const response = await this.handleJSONRPC(jsonrpcReq)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32700, message: 'Parse error' },
              }),
            )
          }
        })
      })

      this.server.listen(port, () => {
        this.port = (this.server.address() as any).port
        console.log(`MCP wrapper for ${this.name} listening on port ${this.port}`)
        resolve(this.port)
      })

      this.server.on('error', reject)
    })
  }

  private async handleJSONRPC(req: JSONRPCRequest): Promise<JSONRPCResponse> {
    // Forward request to stdio process and wait for response
    return new Promise((resolve) => {
      const id = req.id
      this.responseHandlers.set(id, (response: JSONRPCResponse) => {
        this.responseHandlers.delete(id)
        resolve(response)
      })

      // Send request to stdio process
      const message = JSON.stringify(req) + '\n'
      this.child.write(message)

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.responseHandlers.has(id)) {
          this.responseHandlers.delete(id)
          resolve({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'Internal error: timeout' },
          })
        }
      }, 30000)
    })
  }

  async stop(): Promise<void> {
    if (this.child) {
      try {
        await this.child.kill()
      } catch {
        // ignore
      }
    }
    if (this.server) {
      this.server.close()
    }
  }
}

// Global registry of running wrappers
const wrappers = new Map<string, StdioMCPWrapper>()

export async function startStdioMCPWrapper(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string> = {},
  port: number = 0,
): Promise<number> {
  if (wrappers.has(name)) {
    throw new Error(`MCP wrapper for "${name}" is already running`)
  }

  const wrapper = new StdioMCPWrapper(name, command, args, env)
  const boundPort = await wrapper.start(port)
  wrappers.set(name, wrapper)
  return boundPort
}

export async function stopStdioMCPWrapper(name: string): Promise<void> {
  const wrapper = wrappers.get(name)
  if (wrapper) {
    await wrapper.stop()
    wrappers.delete(name)
  }
}

export function getStdioMCPWrapperPort(name: string): number | null {
  return wrappers.get(name)?.port ?? null
}
