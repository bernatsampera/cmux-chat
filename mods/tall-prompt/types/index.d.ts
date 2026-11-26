export type IsTyping = boolean

declare module 'claude-code' {
  interface PluginState {
    'tall-prompt': { isTyping: IsTyping }
  }
}
