import type OpenAI from 'openai'

// openai@4.104.0 ships typings for `client.responses.create()`, but its
// `WebSearchTool.type` union only allows `'web_search_preview'` and
// `'web_search_preview_2025_03_11'`. The Responses API also accepts the
// shorter `'web_search'` form we use here, so we type the request body
// locally rather than loosening the SDK types or augmenting unions
// (which TypeScript doesn't allow). The single SDK-boundary cast is
// confined to this module.

export interface WebSearchToolInput {
  type: 'web_search'
}

export interface ResponsesCreateBody {
  model: string
  input: string
  tools: WebSearchToolInput[]
}

type ResponsesCreateParams = Parameters<OpenAI['responses']['create']>[0]
type ResponsesCreateOptions = Parameters<OpenAI['responses']['create']>[1]

export function createResponse(
  client: OpenAI,
  body: ResponsesCreateBody,
  options?: ResponsesCreateOptions,
) {
  return client.responses.create(body as unknown as ResponsesCreateParams, options)
}
