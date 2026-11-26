import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const isTyping = atom({ plugin: 'tall-prompt', key: 'isTyping' } as const, false)

// In a short terminal a row that has scrolled off the top does not come back. So
// the status lines go with the first character, before the prompt gets a second
// row: an edit hook has 50 ms, too little to wait for the screen.
export const register: Register = on => {
  let last = false

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const typing = box.text !== ''
    if (typing !== last) {
      last = typing
      await update($, isTyping, () => typing)
    }
    return box
  })

  on('prompt.change', async ($, e, next) => {
    const typing = e.text !== ''
    if (typing !== last) {
      last = typing
      await update($, isTyping, () => typing)
    }
    return next(e)
  })

  on('ui.render', { component: 'StatusLine' }, async ($, e, next) => {
    if (!(await read($, isTyping))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
