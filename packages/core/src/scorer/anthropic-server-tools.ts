import type Anthropic from '@anthropic-ai/sdk'

// Anthropic SDK 0.30.1 types `Anthropic.Tool` as a single client-side tool
// shape (input_schema, name, description). It does not yet know about
// server-side tools like `web_search_20250305`, which have a different shape.
// This module provides a small typed boundary so call sites can pass our
// server tools with proper local types instead of reaching for `as unknown`.

export interface WebSearchServerTool {
  type: 'web_search_20250305'
  name: string
  max_uses?: number
}

export type AnthropicServerTool = WebSearchServerTool

// The Anthropic API accepts both client tools and server tools in the same
// `tools` array; the SDK's static type just hasn't been widened yet. The
// runtime payload is correct — we keep the type-loosening confined here.
export function toAnthropicTools(tools: AnthropicServerTool[]): Anthropic.Tool[] {
  return tools as unknown as Anthropic.Tool[]
}
